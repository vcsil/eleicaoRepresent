-- =========================================================================
-- Duas regras eleitorais novas.
--
-- 1. LIBERAÇÃO MANUAL: chegar a hora não abre mais a votação sozinho. O
--    administrador precisa liberar explicitamente, e a liberação é
--    irreversível — é ela que congela a composição da eleição.
--
-- 2. CARGO SEM DISPUTA: cargo cujos candidatos ativos não superam as vagas
--    sai da urna. Ninguém vota onde não há escolha a fazer; esses
--    candidatos são declarados eleitos na APURAÇÃO, não antes.
--
-- Migrations anteriores não são editadas. As funções abaixo partem da
-- versão MAIS RECENTE de cada uma (compute_results vem da 0019, cast_ballot
-- e get_current_voting_election da 0014, compute_election_status da 0010).
-- =========================================================================

-- Estado autoritativo da liberação. Nulo = não liberada.
alter table elections add column if not exists voting_released_at timestamptz;

-- Distingue "eleito sem disputa" de "eleito com 0 votos". Sem esta coluna a
-- tela não teria como saber que não deve exibir contagem alguma.
alter table result_snapshots add column if not exists unopposed boolean not null default false;

-- =========================================================================
-- position_is_contested — a definição única de "há disputa".
--
-- Candidatos ATIVOS vinculados ao cargo contra as vagas dele. Voto nulo não
-- entra: nulo não é candidato e não pode fazer um cargo sem disputa
-- aparecer na urna.
-- =========================================================================
create or replace function public.position_is_contested(p_position_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    (
      select count(*)
      from candidate_positions cp
      join candidates c on c.id = cp.candidate_id
      where cp.position_id = p_position_id and c.active = true
    ) > (select vacancies from positions where id = p_position_id),
    false
  );
$$;

revoke all on function public.position_is_contested(uuid) from public, anon, authenticated;
grant execute on function public.position_is_contested(uuid) to service_role;

-- =========================================================================
-- contested_position_ids — a mesma regra, para a cédula.
--
-- A urna precisa da lista, não do predicado linha a linha (PostgREST não
-- chama função escalar dentro de filtro). Existe para que o frontend NUNCA
-- recalcule "tem disputa" em TypeScript: a mesma definição que
-- `cast_ballot` exige é a que monta a tela.
-- =========================================================================
create or replace function public.contested_position_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(array_agg(id order by display_order), '{}'::uuid[])
  from positions
  where active = true and position_is_contested(id);
$$;

revoke all on function public.contested_position_ids() from public, anon, authenticated;
grant execute on function public.contested_position_ids() to service_role;

-- =========================================================================
-- release_voting — libera a votação, uma vez só.
--
-- Recusa antes da hora inicial. Uma segunda chamada não altera estado nem
-- levanta erro: liberar é idempotente, para que clique duplo ou reenvio de
-- formulário não virem inconsistência.
-- =========================================================================
create or replace function public.release_voting(p_election_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_election elections%rowtype;
  v_votacao record;
begin
  select * into v_election from elections where id = p_election_id for update;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;
  if v_election.type <> 'general' then
    raise exception 'NOT_A_GENERAL_ELECTION';
  end if;

  -- Já liberada: devolve o carimbo existente sem tocar em nada.
  if v_election.voting_released_at is not null then
    return v_election.voting_released_at;
  end if;

  if v_election.voting_closed_manually_at is not null then
    raise exception 'VOTING_ALREADY_CLOSED';
  end if;

  select * into v_votacao from election_phase_bounds(p_election_id, 'votacao');
  if v_votacao.starts_at is null then
    raise exception 'VOTING_WINDOW_NOT_CONFIGURED';
  end if;
  if now() < v_votacao.starts_at then
    raise exception 'VOTING_NOT_STARTED';
  end if;

  update elections set voting_released_at = now() where id = p_election_id;

  select voting_released_at into v_election.voting_released_at
  from elections where id = p_election_id;
  return v_election.voting_released_at;
end;
$$;

revoke all on function public.release_voting(uuid) from public, anon, authenticated;
grant execute on function public.release_voting(uuid) to service_role;

-- =========================================================================
-- compute_election_status — a votação geral depende da LIBERAÇÃO.
--
-- Byte a byte igual à versão da 0010, com uma condição a mais: chegar a
-- hora inicial deixa de ser suficiente.
-- =========================================================================
create or replace function public.compute_election_status(p_election_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_election elections%rowtype;
  v_now timestamptz := now();
  v_edital record;
  v_candidaturas record;
  v_divulgacao record;
  v_apresentacao record;
  v_envio record;
  v_votacao record;
  v_apuracao record;
  v_tie_pending boolean;
  v_dual_pending boolean;
  v_runoff_pending boolean;
  v_apresentacao_end timestamptz;
begin
  select * into v_election from elections where id = p_election_id;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;

  -- Eleições de desempate têm um ciclo simplificado (apenas votação/apuração).
  if v_election.type = 'runoff' then
    select * into v_votacao from election_phase_bounds(p_election_id, 'votacao');

    if v_election.results_published_at is not null then
      return 'resultado_disponivel';
    elsif v_election.results_computed_at is not null then
      return 'aguardando_divulgacao';
    elsif v_votacao.starts_at is not null and v_now >= v_votacao.starts_at and v_now <= v_votacao.ends_at
      and v_election.voting_closed_manually_at is null then
      return 'votacao_desempate';
    elsif v_votacao.ends_at is not null and (v_now > v_votacao.ends_at or v_election.voting_closed_manually_at is not null) then
      return 'em_apuracao';
    else
      return 'aguardando_votacao';
    end if;
  end if;

  if v_election.results_published_at is not null then
    return 'resultado_disponivel';
  end if;

  select exists(
    select 1 from result_snapshots rs
    where rs.election_id = p_election_id and rs.tie_break_needed = true
  ) into v_tie_pending;

  select exists(
    select 1 from position_dual_winner_decisions d
    where d.election_id = p_election_id and d.status = 'pending'
  ) into v_dual_pending;

  select exists(
    select 1 from elections r
    where r.parent_election_id = p_election_id and r.results_published_at is null
  ) into v_runoff_pending;

  if v_election.results_computed_at is not null then
    if v_tie_pending or v_runoff_pending then
      return 'desempate_necessario';
    end if;
    return 'aguardando_divulgacao';
  end if;

  select * into v_edital from election_phase_bounds(p_election_id, 'edital');
  select * into v_candidaturas from election_phase_bounds(p_election_id, 'candidaturas');
  select * into v_divulgacao from election_phase_bounds(p_election_id, 'divulgacao_candidaturas');
  select * into v_apresentacao from election_phase_bounds(p_election_id, 'apresentacao');
  select * into v_envio from election_phase_bounds(p_election_id, 'envio_videos');
  select * into v_votacao from election_phase_bounds(p_election_id, 'votacao');
  select * into v_apuracao from election_phase_bounds(p_election_id, 'apuracao');

  if v_edital.starts_at is null or v_now < v_edital.starts_at then
    return 'nao_iniciada';
  end if;

  if v_candidaturas.starts_at is not null and v_now between v_candidaturas.starts_at and v_candidaturas.ends_at then
    return 'candidaturas_abertas';
  end if;

  v_apresentacao_end := greatest(
    coalesce(v_apresentacao.ends_at, 'epoch'::timestamptz),
    coalesce(v_envio.ends_at, 'epoch'::timestamptz)
  );

  if v_apresentacao.starts_at is not null and v_now between v_apresentacao.starts_at and v_apresentacao_end then
    return 'apresentacao';
  end if;

  -- A janela não basta: a votação só está em andamento depois que o
  -- administrador libera. Antes disso o status permanece
  -- 'aguardando_votacao', mesmo com a hora inicial já vencida.
  if v_election.voting_closed_manually_at is not null
     or (v_votacao.starts_at is not null and v_now between v_votacao.starts_at and v_votacao.ends_at) then
    if v_election.voting_closed_manually_at is null and v_election.voting_released_at is not null then
      return 'votacao_em_andamento';
    end if;
  end if;

  if v_election.voting_closed_manually_at is not null
     or (v_votacao.ends_at is not null and v_now > v_votacao.ends_at) then
    if v_apuracao.starts_at is not null and v_now >= v_apuracao.starts_at then
      return 'em_apuracao';
    end if;
    return 'votacao_encerrada';
  end if;

  if v_votacao.starts_at is not null and v_now < v_votacao.starts_at then
    if v_divulgacao.starts_at is not null and v_now >= v_divulgacao.starts_at and v_now < v_apresentacao.starts_at then
      return 'candidatos_divulgados';
    end if;
    if v_candidaturas.ends_at is not null and v_now > v_candidaturas.ends_at and
       (v_divulgacao.starts_at is null or v_now < v_divulgacao.starts_at) then
      return 'candidaturas_encerradas';
    end if;
    return 'aguardando_votacao';
  end if;

  return 'aguardando_votacao';
end;
$$;

revoke all on function public.compute_election_status(uuid) from public;
grant execute on function public.compute_election_status(uuid) to anon, authenticated, service_role;


-- =========================================================================
-- get_current_voting_election — a urna traz só cargos DISPUTADOS.
--
-- Igual à versão da 0014, com o filtro de disputa na lista de cargos da
-- eleição geral. Se nenhum cargo tiver disputa, a lista volta vazia e a
-- página de votação exibe o aviso próprio — sem urna e sem cédula.
-- =========================================================================
create or replace function public.get_current_voting_election()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_general elections%rowtype;
  v_open uuid[];
  v_election elections%rowtype;
begin
  select * into v_general from elections
  where type = 'general' order by created_at asc limit 1;
  if not found then
    return null;
  end if;

  if compute_election_status(v_general.id) = 'votacao_em_andamento' then
    return jsonb_build_object(
      'election_id', v_general.id,
      'type', 'general',
      'parent_election_id', null,
      'positions', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'position_id', p.id,
          'votes_per_voter', p.votes_per_voter,
          'vacancies', p.vacancies
        ) order by p.display_order), '[]'::jsonb)
        from positions p
        where p.active = true and position_is_contested(p.id)
      )
    );
  end if;

  select array_agg(e.id) into v_open
  from elections e
  where e.type = 'runoff'
    and compute_election_status(e.id) = 'votacao_desempate';

  if v_open is null then
    return null;
  end if;
  if array_length(v_open, 1) > 1 then
    raise exception 'AMBIGUOUS_ACTIVE_ELECTION';
  end if;

  select * into v_election from elections where id = v_open[1];

  return jsonb_build_object(
    'election_id', v_election.id,
    'type', 'runoff',
    'parent_election_id', v_election.parent_election_id,
    'positions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'position_id', rp.position_id,
        'votes_per_voter', rp.votes_per_voter,
        'vacancies', rp.vacancies_in_dispute
      ) order by p.display_order), '[]'::jsonb)
      from runoff_positions rp
      join positions p on p.id = rp.position_id
      where rp.runoff_election_id = v_election.id
    )
  );
end;
$$;

revoke all on function public.get_current_voting_election() from public;
grant execute on function public.get_current_voting_election() to anon, authenticated, service_role;


-- =========================================================================
-- cast_ballot — exige votos apenas para cargos DISPUTADOS.
--
-- Igual à versão da 0014, com a lista de cargos obrigatórios filtrada. Toda
-- a validação existente (soma exata, nulo, repetição, candidato ativo,
-- unicidade por eleição, atomicidade) permanece.
-- =========================================================================
create or replace function public.cast_ballot(
  p_session_token text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token_hash text;
  v_session vote_sessions%rowtype;
  v_voter voters%rowtype;
  v_election elections%rowtype;
  v_status text;
  v_ballot_id uuid;
  v_required_positions uuid[];
  v_position_id uuid;
  v_votes_per_voter int;
  v_position_payload jsonb;
  v_allocation jsonb;
  v_sum int;
  v_slot int;
  v_quantity int;
  v_quantity_numeric numeric;
  v_candidate_id uuid;
  v_is_null boolean;
  v_seen_keys text[];
  v_key text;
begin
  if p_session_token is null or length(p_session_token) < 32 then
    raise exception 'SESSION_INVALID';
  end if;

  v_token_hash := encode(digest(p_session_token, 'sha256'), 'hex');

  select * into v_session from vote_sessions where token_hash = v_token_hash for update;
  if not found then
    raise exception 'SESSION_INVALID';
  end if;
  if v_session.consumed_at is not null then
    raise exception 'SESSION_INVALID';
  end if;
  if v_session.expires_at < now() then
    raise exception 'SESSION_EXPIRED';
  end if;

  select * into v_voter from voters where id = v_session.voter_id for update;
  if not found or not v_voter.active then
    raise exception 'VOTER_INACTIVE';
  end if;

  select * into v_election from elections where id = v_session.election_id;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;

  v_status := compute_election_status(v_session.election_id);
  if v_status <> 'votacao_em_andamento' and v_status <> 'votacao_desempate' then
    raise exception 'VOTING_CLOSED';
  end if;

  if exists(
    select 1 from audit_vote_links al
    where al.election_id = v_session.election_id and al.voter_id = v_voter.id
  ) then
    raise exception 'ALREADY_VOTED';
  end if;

  if p_payload is null or jsonb_typeof(p_payload -> 'positions') <> 'array'
     or (p_payload - 'positions') <> '{}'::jsonb then
    raise exception 'INVALID_PAYLOAD';
  end if;

  -- Posições obrigatórias: todas as ativas numa eleição geral; apenas a
  -- posição em disputa numa eleição de desempate.
  if v_election.type = 'runoff' then
    -- Um desempate pode cobrir vários cargos empatados; a lista sai de
    -- runoff_positions, não da coluna singular legada.
    select array_agg(position_id) into v_required_positions
    from runoff_positions where runoff_election_id = v_session.election_id;
  else
    -- Só cargos com disputa são exigidos. Um payload que traga cargo sem
    -- disputa não encontra correspondência aqui e cai em INVALID_PAYLOAD —
    -- esconder no frontend nunca foi suficiente.
    select array_agg(id) into v_required_positions
    from positions where active = true and position_is_contested(id);
  end if;

  if v_required_positions is null or array_length(v_required_positions, 1) is null then
    raise exception 'INVALID_PAYLOAD';
  end if;

  if jsonb_array_length(p_payload -> 'positions') <> array_length(v_required_positions, 1) then
    raise exception 'INVALID_PAYLOAD';
  end if;

  insert into ballots (election_id, submitted_at)
  values (v_session.election_id, now())
  returning id into v_ballot_id;

  foreach v_position_id in array v_required_positions loop
    if v_election.type = 'runoff' then
      select rp.votes_per_voter into v_votes_per_voter
      from runoff_positions rp
      where rp.runoff_election_id = v_session.election_id and rp.position_id = v_position_id;
    else
      select p.votes_per_voter into v_votes_per_voter from positions p where p.id = v_position_id;
    end if;

    if v_votes_per_voter is null then
      raise exception 'INVALID_PAYLOAD';
    end if;

    select value into v_position_payload
    from jsonb_array_elements(p_payload -> 'positions') as value
    where (value ->> 'position_id')::uuid = v_position_id;

    if v_position_payload is null
       or (v_position_payload - 'position_id' - 'allocations') <> '{}'::jsonb then
      raise exception 'INVALID_PAYLOAD';
    end if;

    if jsonb_typeof(v_position_payload -> 'allocations') <> 'array'
       or jsonb_array_length(v_position_payload -> 'allocations') = 0 then
      raise exception 'INVALID_PAYLOAD';
    end if;

    v_sum := 0;
    v_slot := 0;
    v_seen_keys := '{}';

    for v_allocation in select * from jsonb_array_elements(v_position_payload -> 'allocations') loop
      if not (v_allocation ? 'quantity') or jsonb_typeof(v_allocation -> 'quantity') <> 'number'
         or (v_allocation - 'candidate_id' - 'is_null_vote' - 'quantity') <> '{}'::jsonb then
        raise exception 'INVALID_PAYLOAD';
      end if;

      -- Cast para numeric primeiro: um cast direto para ::int falha com um
      -- erro bruto do Postgres (não a exceção INVALID_PAYLOAD) para valores
      -- como 1.5. numeric aceita qualquer number do JSON sem erro.
      v_quantity_numeric := (v_allocation ->> 'quantity')::numeric;

      if v_quantity_numeric <> trunc(v_quantity_numeric) or v_quantity_numeric < 0 then
        raise exception 'INVALID_PAYLOAD';
      end if;

      v_quantity := v_quantity_numeric::int;
      v_is_null := coalesce((v_allocation ->> 'is_null_vote')::boolean, false);

      if v_quantity = 0 then
        continue;
      end if;

      if v_is_null then
        v_candidate_id := null;
        v_key := 'null';
      else
        if not (v_allocation ? 'candidate_id') or v_allocation ->> 'candidate_id' is null then
          raise exception 'INVALID_PAYLOAD';
        end if;
        v_candidate_id := (v_allocation ->> 'candidate_id')::uuid;
        v_key := v_candidate_id::text;

        if v_election.type = 'runoff' then
          -- Agora escopado por cargo: um candidato empatado em Tesouraria
          -- não pode receber voto na disputa de Presidente.
          if not exists(
            select 1 from runoff_candidates rc
            where rc.runoff_election_id = v_session.election_id
              and rc.position_id = v_position_id
              and rc.candidate_id = v_candidate_id
          ) then
            raise exception 'INVALID_CANDIDATE';
          end if;
        else
          if not exists(
            select 1 from candidate_positions cp
            join candidates c on c.id = cp.candidate_id
            where cp.position_id = v_position_id and cp.candidate_id = v_candidate_id and c.active = true
          ) then
            raise exception 'INVALID_CANDIDATE';
          end if;
        end if;
      end if;

      if v_key = any(v_seen_keys) then
        raise exception 'INVALID_PAYLOAD';
      end if;
      v_seen_keys := array_append(v_seen_keys, v_key);

      v_sum := v_sum + v_quantity;
      if v_sum > v_votes_per_voter then
        raise exception 'INVALID_VOTE_SUM';
      end if;

      for i in 1..v_quantity loop
        v_slot := v_slot + 1;
        insert into ballot_choices (ballot_id, position_id, candidate_id, is_null_vote, vote_slot)
        values (v_ballot_id, v_position_id, v_candidate_id, v_is_null, v_slot);
      end loop;
    end loop;

    if v_sum <> v_votes_per_voter then
      raise exception 'INVALID_VOTE_SUM';
    end if;
  end loop;

  insert into audit_vote_links (election_id, voter_id, ballot_id)
  values (v_session.election_id, v_voter.id, v_ballot_id);

  update voters set has_voted = true, voted_at = now() where id = v_voter.id;
  update vote_sessions set consumed_at = now() where id = v_session.id;

  return v_ballot_id;
end;
$$;

revoke all on function public.cast_ballot(text, jsonb) from public;
grant execute on function public.cast_ballot(text, jsonb) to anon, authenticated, service_role;

-- =========================================================================
-- compute_results — cargos SEM DISPUTA.
--
-- Parte da versão da 0019 (que já trazia o ON CONFLICT do índice parcial) e
-- acrescenta o ramo de cargo sem disputa. O ramo de cargo disputado fica
-- intacto, assim como o desempate.
-- =========================================================================
create or replace function public.compute_results(p_election_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_election elections%rowtype;
  v_position record;
  v_vacancies int;
  v_elegiveis int;
begin
  select * into v_election from elections where id = p_election_id;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;

  if v_election.results_published_at is not null then
    raise exception 'ALREADY_PUBLISHED';
  end if;

  if not election_voting_closed(p_election_id) then
    raise exception 'VOTING_NOT_CLOSED';
  end if;

  delete from result_snapshots where election_id = p_election_id;

  -- Um desempate pode cobrir vários cargos: a lista sai de runoff_positions,
  -- e não mais da coluna singular elections.runoff_position_id.
  for v_position in
    select rp.position_id as id, rp.votes_per_voter, p.name,
           rp.vacancies_in_dispute as vacancies
    from runoff_positions rp
    join positions p on p.id = rp.position_id
    where v_election.type = 'runoff' and rp.runoff_election_id = p_election_id
    union all
    select p.id, p.votes_per_voter, p.name, p.vacancies
    from positions p
    where v_election.type = 'general' and p.active = true
  loop
    v_vacancies := v_position.vacancies;

    -- Quantos candidatos ativos disputam este cargo. Num desempate a lista
    -- vem de runoff_candidates e a regra de "sem disputa" não se aplica:
    -- um desempate só existe porque houve empate na linha de corte.
    if v_election.type = 'general' then
      select count(*) into v_elegiveis
      from candidate_positions cp
      join candidates c on c.id = cp.candidate_id
      where cp.position_id = v_position.id and c.active = true;
    else
      v_elegiveis := v_vacancies + 1; -- força o caminho de disputa
    end if;

    -- CARGO SEM DISPUTA: candidatos não superam as vagas.
    --
    -- Ninguém votou neste cargo (ele nem apareceu na urna), então não há
    -- contagem a fazer. Os candidatos são declarados eleitos AQUI, na
    -- apuração — não antes — e marcados como `unopposed` para que a tela
    -- não exiba "0 votos" para quem nunca foi votado. Nenhum voto
    -- artificial é criado, e nenhuma linha de nulos: não houve cédula.
    --
    -- Zero candidatos: nenhuma linha, ninguém eleito. As vagas ficam
    -- vazias, e a tela deriva isso de (vagas - eleitos).
    if v_elegiveis <= v_vacancies then
      if v_elegiveis > 0 then
        insert into result_snapshots (
          election_id, position_id, candidate_id, votes_count, rank, elected,
          tie_break_needed, unopposed, candidate_name, candidate_photo_path, position_name
        )
        select
          p_election_id, v_position.id, c.id, 0,
          row_number() over (order by c.display_order, c.full_name),
          true, false, true, c.full_name, c.photo_path, v_position.name
        from candidate_positions cp
        join candidates c on c.id = cp.candidate_id
        where cp.position_id = v_position.id and c.active = true;

        -- Rótulos de assento valem igualmente para quem foi eleito sem
        -- disputa: a vaga ocupada é a mesma.
        update result_snapshots rs
        set seat_label = pos.seat_labels[er.seat_index]
        from (
          select id, row_number() over (order by rank asc) as seat_index
          from result_snapshots
          where election_id = p_election_id and position_id = v_position.id and elected = true
        ) er
        join positions pos on pos.id = v_position.id
        where rs.id = er.id
          and pos.seat_labels is not null
          and er.seat_index <= array_length(pos.seat_labels, 1);
      end if;

      continue;
    end if;

    with eligible_candidates as (
      select cp.candidate_id
      from candidate_positions cp
      join candidates c on c.id = cp.candidate_id
      where v_election.type = 'general' and cp.position_id = v_position.id and c.active = true
      union
      select rc.candidate_id
      from runoff_candidates rc
      where v_election.type = 'runoff' and rc.runoff_election_id = p_election_id
        and rc.position_id = v_position.id
    ),
    vote_counts as (
      select bc.candidate_id, count(*)::int as votes_count
      from ballot_choices bc
      join ballots b on b.id = bc.ballot_id
      where b.election_id = p_election_id
        and bc.position_id = v_position.id
        and bc.is_null_vote = false
      group by bc.candidate_id
    ),
    -- Todo candidato elegível entra no resultado, mesmo com 0 votos
    -- (seção 51 exige mostrar a classificação completa, não só quem votou).
    counts as (
      select ec.candidate_id, coalesce(vc.votes_count, 0) as votes_count
      from eligible_candidates ec
      left join vote_counts vc on vc.candidate_id = ec.candidate_id
    ),
    ranked as (
      select
        candidate_id,
        votes_count,
        rank() over (order by votes_count desc) as rnk,
        count(*) over (partition by votes_count) as tie_group_size
      from counts
    )
    insert into result_snapshots (
      election_id, position_id, candidate_id, votes_count, rank, elected, tie_break_needed,
      candidate_name, candidate_photo_path, position_name
    )
    select
      p_election_id, v_position.id, ranked.candidate_id, ranked.votes_count, ranked.rnk,
      (ranked.rnk <= v_vacancies and (ranked.rnk + ranked.tie_group_size - 1) <= v_vacancies),
      (ranked.rnk <= v_vacancies and (ranked.rnk + ranked.tie_group_size - 1) > v_vacancies),
      c.full_name, c.photo_path, v_position.name
    from ranked
    join candidates c on c.id = ranked.candidate_id;

    insert into result_snapshots (
      election_id, position_id, candidate_id, votes_count, rank, elected, tie_break_needed, position_name
    )
    select
      p_election_id, v_position.id, null,
      count(*) filter (where bc.is_null_vote = true),
      null, false, false, v_position.name
    from ballots b
    left join ballot_choices bc on bc.ballot_id = b.id and bc.position_id = v_position.id
    where b.election_id = p_election_id;

    -- Rótulos de assento só na eleição geral: num desempate eles são
    -- atribuídos ao resolver o pai, continuando a numeração de lá.
    if v_election.type = 'general' then
      update result_snapshots rs
      set seat_label = pos.seat_labels[er.seat_index]
      from (
        select id, row_number() over (order by rank asc) as seat_index
        from result_snapshots
        where election_id = p_election_id and position_id = v_position.id and elected = true
      ) er
      join positions pos on pos.id = v_position.id
      where rs.id = er.id
        and pos.seat_labels is not null
        and er.seat_index <= array_length(pos.seat_labels, 1);
    end if;
  end loop;

  if v_election.type = 'general' then
    insert into position_dual_winner_decisions (election_id, candidate_id, position_id_a, position_id_b)
    select p_election_id, candidate_id, min(position_id::text)::uuid, max(position_id::text)::uuid
    from result_snapshots
    where election_id = p_election_id and elected = true and candidate_id is not null
    group by candidate_id
    having count(distinct position_id) = 2
    on conflict (election_id, candidate_id) where status = 'pending' do nothing;
  end if;

  update elections set results_computed_at = now() where id = p_election_id;
end;
$$;

revoke all on function public.compute_results(uuid) from public, anon, authenticated;
grant execute on function public.compute_results(uuid) to service_role;
