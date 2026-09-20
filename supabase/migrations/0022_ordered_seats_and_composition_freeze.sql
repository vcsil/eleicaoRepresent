-- =========================================================================
-- 0022 — cargos com assentos ordenados (edital).
--
-- A regra "candidatos <= vagas => sem disputa" não vale para todo cargo.
-- Tesouraria e Secretaria têm assentos NOMEADOS (Primeiro/Segundo), e é a
-- votação que define QUEM ocupa cada um — mesmo com um único candidato,
-- mesmo com candidatos em número igual às vagas.
--
-- O que distingue esses cargos já existe no schema: `positions.seat_labels`.
-- Nada de slug no código.
--
--   seat_labels IS NOT NULL  -> vota sempre que houver ao menos 1 candidato
--   seat_labels IS NULL      -> vota só quando candidatos > vagas
--
-- Além disso:
--  - empate que torne a ORDEM dos assentos indefinida vira desempate,
--    mesmo quando todos os empatados seriam eleitos de qualquer forma;
--  - o desempate de cargo ordenado dá 1 voto por eleitor, porque ali se
--    escolhe uma ordem, não um conjunto;
--  - a composição eleitoral passa a ser congelada por TRIGGER, não só
--    pelas funções de gravação: escrita direta no banco também é recusada.
-- =========================================================================


-- =========================================================================
-- A REGRA, em um lugar só.
--
-- Todo consumidor — liberação, preview do admin, cédula,
-- get_current_voting_election, cast_ballot e compute_results — passa a
-- perguntar aqui. Antes `compute_results` repetia a comparação inline, e
-- era exatamente o tipo de duplicação que deixa a urna e a apuração
-- discordarem.
-- =========================================================================
create or replace function public.position_requires_voting(p_position_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce((
    select
      v_candidatos > 0
      and (p.seat_labels is not null or v_candidatos > p.vacancies)
    from positions p
    cross join lateral (
      select count(*)::int
      from candidate_positions cp
      join candidates c on c.id = cp.candidate_id
      where cp.position_id = p.id and c.active = true
    ) as contagem(v_candidatos)
    where p.id = p_position_id
  ), false);
$$;

revoke all on function public.position_requires_voting(uuid) from public, anon, authenticated;
grant execute on function public.position_requires_voting(uuid) to service_role;

-- Nome antigo mantido como delegação: qualquer chamador que tenha ficado
-- para trás continua recebendo a MESMA resposta, em vez de divergir em
-- silêncio.
create or replace function public.position_is_contested(p_position_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select position_requires_voting(p_position_id);
$$;

revoke all on function public.position_is_contested(uuid) from public, anon, authenticated;
grant execute on function public.position_is_contested(uuid) to service_role;

create or replace function public.voting_position_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(array_agg(id order by display_order), '{}'::uuid[])
  from positions
  where active = true and position_requires_voting(id);
$$;

revoke all on function public.voting_position_ids() from public, anon, authenticated;
grant execute on function public.voting_position_ids() to service_role;

create or replace function public.contested_position_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select voting_position_ids();
$$;

revoke all on function public.contested_position_ids() from public, anon, authenticated;
grant execute on function public.contested_position_ids() to service_role;


-- =========================================================================
-- A urna e o envio passam a usar a regra nova.
-- Base: versões da 0020, com o predicado trocado — nada mais.
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
        where p.active = true and position_requires_voting(p.id)
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
    -- Só cargos que VÃO À URNA são exigidos. Um payload que traga cargo sem
    -- disputa não encontra correspondência aqui e cai em INVALID_PAYLOAD —
    -- esconder no frontend nunca foi suficiente.
    select array_agg(id) into v_required_positions
    from positions where active = true and position_requires_voting(id);
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

revoke all on function public.cast_ballot(text, jsonb) from public, anon, authenticated;
grant execute on function public.cast_ballot(text, jsonb) to service_role;


-- =========================================================================
-- compute_results — base 0021, com três mudanças.
--
--  1. a classificação "precisa votar?" passa a ser a do helper único;
--  2. cargo ordenado trata empate na faixa eleita como pendência de ORDEM;
--  3. a numeração de assentos deixa de depender da ordem física das linhas.
--
-- A guarda UNCONTESTED_POSITION_HAS_VOTES continua: ela é a rede que pega
-- inconsistência que nenhuma invariante deveria permitir.
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
  v_ordenado boolean;
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
    -- Cargo com assentos NOMEADOS: a votação define a ORDEM, então ele vai
    -- à urna mesmo com candidatos <= vagas.
    select seat_labels is not null into v_ordenado from positions where id = v_position.id;

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
    -- A MESMA pergunta que a urna fez. Nunca uma comparação repetida aqui:
    -- se a apuração classificasse diferente da cédula, um cargo votado
    -- seria apurado como sem disputa (ou o contrário).
    if v_election.type = 'general' and not position_requires_voting(v_position.id) then
      -- Guarda de integridade: este cargo não deveria ter recebido voto
      -- nenhum (sem disputa, ele nem entra na urna). Se houver escolha
      -- registrada, os dados vêm de antes da regra — uma eleição que já
      -- estava em andamento quando a 0020 foi aplicada. Apurar como "sem
      -- disputa" apagaria a contagem real e o rótulo de assento derivado
      -- dela. Recusa alto, em vez de decidir sozinha o que fazer com voto
      -- de verdade; o procedimento está no README.
      if exists (
        select 1 from ballot_choices bc
        join ballots b on b.id = bc.ballot_id
        where b.election_id = p_election_id and bc.position_id = v_position.id
      ) then
        raise exception 'UNCONTESTED_POSITION_HAS_VOTES';
      end if;

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

        -- Nada de rótulo de assento aqui. Um cargo só chega a este ramo
        -- quando NÃO vai à urna, e desde a 0022 isso implica
        -- `seat_labels is null` — cargo com assento nomeado sempre vota,
        -- porque é a votação que define Primeiro e Segundo. O UPDATE que
        -- existia aqui nunca teria linha para atribuir.
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
      -- Cargo ordenado: empate DENTRO da faixa eleita também é pendência,
      -- porque deixa indefinido QUAL assento cada um ocupa. Ana 50 x Bruno
      -- 50 para 2 vagas elege os dois de qualquer forma, mas não diz quem é
      -- Primeiro e quem é Segundo — e a numeração sairia da ordem em que o
      -- banco devolvesse as linhas.
      --
      -- Cargo sem assento nomeado mantém exatamente a regra anterior: só o
      -- empate que cruza a linha de corte é pendência.
      case when v_ordenado
        then (ranked.rnk <= v_vacancies and ranked.tie_group_size = 1)
        else (ranked.rnk <= v_vacancies and (ranked.rnk + ranked.tie_group_size - 1) <= v_vacancies)
      end,
      case when v_ordenado
        then (ranked.rnk <= v_vacancies and ranked.tie_group_size > 1)
        else (ranked.rnk <= v_vacancies and (ranked.rnk + ranked.tie_group_size - 1) > v_vacancies)
      end,
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
        -- Desempate da ordenação por votos e, em último caso, pelo id:
        -- entre eleitos não pode haver empate de votos num cargo ordenado
        -- (isso vira tie_break_needed), então o id só existe para a
        -- numeração ser determinística e nunca depender da ordem física.
        select id, row_number() over (
                 order by votes_count desc, candidate_id asc
               ) as seat_index
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


-- =========================================================================
-- create_runoff_election — base 0019 (a MAIS RECENTE: é ela que traz a
-- guarda de janelas sobrepostas e a precedência de RUNOFF_ALREADY_EXISTS).
--
-- Única mudança: o desempate de cargo ordenado dá 1 voto por eleitor.
-- Vagas em disputa continuam derivadas (vagas do cargo menos as já
-- definidas), então empate parcial não reabre assento já decidido.
-- =========================================================================
create or replace function public.create_runoff_election(
  p_parent_election_id uuid,
  p_position_ids uuid[],
  p_reason text,
  p_starts_on date,
  p_ends_on date,
  p_start_time time,
  p_end_time time
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_parent elections%rowtype;
  v_runoff_id uuid;
  v_position_id uuid;
  v_base_vacancies int;
  v_already_elected int;
  v_in_dispute int;
  v_ordenado boolean;
  v_tied int;
  v_names text;
  v_new_starts_at timestamptz;
  v_new_ends_at timestamptz;
begin
  select * into v_parent from elections where id = p_parent_election_id for update;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;
  if v_parent.results_computed_at is null then
    raise exception 'RESULTS_NOT_COMPUTED';
  end if;
  if v_parent.results_published_at is not null then
    raise exception 'ALREADY_PUBLISHED';
  end if;
  if p_position_ids is null or array_length(p_position_ids, 1) is null then
    raise exception 'NO_POSITIONS';
  end if;

  -- Mesma conversão de fuso de election_phase_bounds, para que a
  -- comparação abaixo seja entre grandezas iguais.
  v_new_starts_at := (p_starts_on::text || ' ' || p_start_time::text)::timestamp
                       at time zone 'America/Sao_Paulo';
  v_new_ends_at := (p_ends_on::text || ' ' || p_end_time::text)::timestamp
                       at time zone 'America/Sao_Paulo';

  -- Duplicação POR CARGO é verificada antes da sobreposição de janela: para
  -- um segundo desempate do mesmo cargo, "já existe desempate para este
  -- cargo" é um diagnóstico melhor do que "janela sobreposta", e é a
  -- mensagem que a interface já traduz.
  foreach v_position_id in array p_position_ids loop
    if exists (
      select 1 from runoff_positions
      where parent_election_id = p_parent_election_id
        and position_id = v_position_id
        and resolved_at is null
    ) then
      raise exception 'RUNOFF_ALREADY_EXISTS';
    end if;
  end loop;

  -- get_current_voting_election() percorre TODOS os desempates e falha alto
  -- se achar mais de um aberto. Duas janelas sobrepostas produzem
  -- exatamente isso — e a urna cai para todo mundo. Só desempates que ainda
  -- podem abrir entram na comparação: um já encerrado, apurado ou publicado
  -- nunca volta ao ar.
  if exists (
    select 1
    from elections e
    join lateral election_phase_bounds(e.id, 'votacao') b on true
    where e.type = 'runoff'
      and e.results_published_at is null
      and e.results_computed_at is null
      and e.voting_closed_manually_at is null
      and b.starts_at is not null
      and b.ends_at >= now()
      and tstzrange(b.starts_at, b.ends_at, '[]')
          && tstzrange(v_new_starts_at, v_new_ends_at, '[]')
  ) then
    raise exception 'RUNOFF_WINDOW_OVERLAP';
  end if;

  select string_agg(p.name, ', ' order by p.display_order) into v_names
  from positions p where p.id = any(p_position_ids);

  insert into elections (type, parent_election_id, name, runoff_reason)
  values ('runoff', p_parent_election_id, 'Desempate — ' || coalesce(v_names, ''), p_reason)
  returning id into v_runoff_id;

  foreach v_position_id in array p_position_ids loop
    select count(*) into v_tied
    from result_snapshots
    where election_id = p_parent_election_id and position_id = v_position_id
      and tie_break_needed = true and candidate_id is not null;

    if v_tied < 2 then
      raise exception 'NO_TIE_FOR_POSITION';
    end if;

    if exists (
      select 1 from runoff_positions
      where parent_election_id = p_parent_election_id
        and position_id = v_position_id
        and resolved_at is null
    ) then
      raise exception 'RUNOFF_ALREADY_EXISTS';
    end if;

    if v_parent.type = 'general' then
      select vacancies into v_base_vacancies from positions where id = v_position_id;
    else
      select vacancies_in_dispute into v_base_vacancies
      from runoff_positions
      where runoff_election_id = p_parent_election_id and position_id = v_position_id;
    end if;

    if v_base_vacancies is null then
      raise exception 'POSITION_NOT_IN_PARENT';
    end if;

    select count(*) into v_already_elected
    from result_snapshots
    where election_id = p_parent_election_id and position_id = v_position_id and elected = true;

    v_in_dispute := v_base_vacancies - v_already_elected;
    if v_in_dispute < 1 then
      raise exception 'NO_VACANCY_IN_DISPUTE';
    end if;

    -- Votos por eleitor.
    --
    -- Cargo com assentos nomeados: SEMPRE 1, qualquer que seja o número de
    -- vagas em disputa. Ali o desempate escolhe uma ORDEM, não um conjunto:
    -- dois votos para quem decide entre Primeiro e Segundo Tesoureiro
    -- permitiriam votar nos dois e não decidir nada.
    --
    -- Cargo sem assento nomeado: regra inalterada — votos por eleitor =
    -- vagas em disputa, com repetição permitida no mesmo candidato.
    select seat_labels is not null into v_ordenado from positions where id = v_position_id;

    insert into runoff_positions (
      runoff_election_id, parent_election_id, position_id, vacancies_in_dispute, votes_per_voter
    )
    values (
      v_runoff_id, p_parent_election_id, v_position_id, v_in_dispute,
      case when v_ordenado then 1 else v_in_dispute end
    );

    insert into runoff_candidates (runoff_election_id, position_id, candidate_id)
    select v_runoff_id, v_position_id, rs.candidate_id
    from result_snapshots rs
    where rs.election_id = p_parent_election_id
      and rs.position_id = v_position_id
      and rs.tie_break_needed = true
      and rs.candidate_id is not null;
  end loop;

  insert into election_phases (
    election_id, phase_key, label, starts_on, ends_on, start_time, end_time,
    time_configured, display_order
  )
  values (
    v_runoff_id, 'votacao', 'Votação de desempate',
    p_starts_on, p_ends_on, p_start_time, p_end_time, true, 1
  );

  return v_runoff_id;
exception
  when unique_violation then
    raise exception 'RUNOFF_ALREADY_EXISTS';
end;
$$;

revoke all on function public.create_runoff_election(uuid, uuid[], text, date, date, time, time)
  from public, anon, authenticated;
grant execute on function public.create_runoff_election(uuid, uuid[], text, date, date, time, time)
  to service_role;

-- =========================================================================
-- CAMADA 1 — congelamento no banco, por trigger.
--
-- `save_candidate` e `set_candidate_active` já recusavam alteração depois
-- da liberação, mas só quem passa POR ELAS. Um UPDATE direto na tabela —
-- psql, SQL Editor do painel, um script — passava por fora, e `positions`
-- não tinha proteção alguma: mudar `vacancies` ou apagar `seat_labels` no
-- meio da votação reclassificaria o cargo e faria um cargo votado virar
-- "sem disputa".
--
-- O lock é `for share` na linha da eleição, e não uma leitura solta: ele
-- conflita com o `for update` de `release_voting`, então uma escrita
-- concorrente com a liberação ou termina inteira antes dela, ou espera e
-- é recusada. Várias edições simultâneas entre si não se bloqueiam.
-- =========================================================================
create or replace function public.composition_is_frozen()
returns boolean
language plpgsql
-- VOLATILE (padrão) de propósito: `select ... for share` não é permitido
-- em função estável, e o lock é o ponto desta função — sem ele a leitura
-- do congelamento voltaria a correr contra a liberação.
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_released timestamptz;
begin
  select voting_released_at into v_released
  from elections
  where type = 'general'
  order by created_at asc
  limit 1
  for share;

  -- Sem eleição cadastrada não há votação a proteger (instalação nova,
  -- antes do seed).
  return found and v_released is not null;
end;
$$;

revoke all on function public.composition_is_frozen() from public, anon, authenticated;
grant execute on function public.composition_is_frozen() to service_role;


-- candidates: entrar, sair e mudar o que define a composição.
-- Foto, frase, apresentação, propostas e vídeo continuam livres — é por
-- isso que o UPDATE compara campo a campo em vez de bloquear a linha
-- inteira.
create or replace function public.tg_freeze_candidates()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.full_name is not distinct from old.full_name
     and new.active is not distinct from old.active
     and new.display_order is not distinct from old.display_order then
    return new;
  end if;

  if composition_is_frozen() then
    raise exception 'COMPOSITION_FROZEN';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists freeze_candidates on public.candidates;
create trigger freeze_candidates
  before insert or update or delete on public.candidates
  for each row execute function public.tg_freeze_candidates();


-- candidate_positions: a tabela é inteira estrutural — quem concorre a quê
-- é exatamente o que define a cédula.
create or replace function public.tg_freeze_candidate_positions()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if composition_is_frozen() then
    raise exception 'COMPOSITION_FROZEN';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists freeze_candidate_positions on public.candidate_positions;
create trigger freeze_candidate_positions
  before insert or update or delete on public.candidate_positions
  for each row execute function public.tg_freeze_candidate_positions();


-- positions: nenhuma tela administrativa escreve aqui hoje, e é justamente
-- por isso que faltava proteção. `vacancies`, `votes_per_voter`,
-- `seat_labels`, `active` e `display_order` decidem se o cargo vai à urna,
-- quantos votos cada eleitor tem e como os assentos são numerados.
-- Descrição, nome, perfil e ícone continuam editáveis.
create or replace function public.tg_freeze_positions()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.active is not distinct from old.active
     and new.vacancies is not distinct from old.vacancies
     and new.votes_per_voter is not distinct from old.votes_per_voter
     and new.seat_labels is not distinct from old.seat_labels
     and new.display_order is not distinct from old.display_order
     and new.slug is not distinct from old.slug then
    return new;
  end if;

  if composition_is_frozen() then
    raise exception 'COMPOSITION_FROZEN';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists freeze_positions on public.positions;
create trigger freeze_positions
  before insert or update or delete on public.positions
  for each row execute function public.tg_freeze_positions();
