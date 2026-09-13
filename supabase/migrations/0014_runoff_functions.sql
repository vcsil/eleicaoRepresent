-- =========================================================================
-- Desempate: funções (etapa 2A).
--
-- Corrige o buraco estrutural do fluxo anterior: o desempate era criado e
-- apurado, mas NADA resolvia o empate da eleição principal. publish_results
-- do pai levantava TIE_PENDING para sempre — a única coisa no repositório
-- que zerava tie_break_needed era uma fixture de teste.
--
-- Três mudanças de fundo:
--   1. create_runoff_election DERIVA candidatos e vagas do banco, em vez de
--      confiar em campos vindos do navegador.
--   2. publish_results de um desempate resolve o pai na MESMA transação —
--      assim é impossível, por construção, existir desempate publicado com
--      pai travado.
--   3. compute_results e cast_ballot passam a tratar desempate multi-cargo.
--
-- Os votos da eleição original nunca são tocados: os dois pleitos são
-- registros distintos.
-- =========================================================================

-- =========================================================================
-- create_runoff_election — nada do cliente decide o resultado.
--
-- O chamador informa apenas QUAIS cargos e QUANDO. Quem participa e quantas
-- vagas estão em jogo sai de result_snapshots, que é produto da apuração.
-- =========================================================================
drop function if exists public.create_runoff_election(uuid, uuid, uuid[], int, int, text, date, date, time, time);

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
  v_tied int;
  v_names text;
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

  select string_agg(p.name, ', ' order by p.display_order) into v_names
  from positions p where p.id = any(p_position_ids);

  insert into elections (type, parent_election_id, name, runoff_reason)
  values ('runoff', p_parent_election_id, 'Desempate — ' || coalesce(v_names, ''), p_reason)
  returning id into v_runoff_id;

  foreach v_position_id in array p_position_ids loop
    -- Só existe desempate onde a apuração apontou empate na linha de corte.
    select count(*) into v_tied
    from result_snapshots
    where election_id = p_parent_election_id and position_id = v_position_id
      and tie_break_needed = true and candidate_id is not null;

    if v_tied < 2 then
      raise exception 'NO_TIE_FOR_POSITION';
    end if;

    -- Já existe desempate aberto para este cargo? (o índice parcial em
    -- runoff_positions é o backstop para corrida; isto dá o erro claro)
    if exists (
      select 1 from runoff_positions
      where parent_election_id = p_parent_election_id
        and position_id = v_position_id
        and resolved_at is null
    ) then
      raise exception 'RUNOFF_ALREADY_EXISTS';
    end if;

    -- Vagas base: do cargo numa eleição geral; da rodada anterior quando o
    -- desempate é encadeado (empate que se repetiu).
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

    -- Vagas REALMENTE em disputa. Ex.: 3 vagas, 1 já definida, 3 empatados
    -- pelas 2 restantes -> 2. Derivado, nunca digitado.
    v_in_dispute := v_base_vacancies - v_already_elected;
    if v_in_dispute < 1 then
      raise exception 'NO_VACANCY_IN_DISPUTE';
    end if;

    -- votos por eleitor = vagas em disputa, com repetição permitida no mesmo
    -- candidato — mesma regra da eleição geral.
    insert into runoff_positions (
      runoff_election_id, parent_election_id, position_id, vacancies_in_dispute, votes_per_voter
    )
    values (v_runoff_id, p_parent_election_id, v_position_id, v_in_dispute, v_in_dispute);

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
    -- Corrida entre dois cliques simultâneos: o índice parcial decide.
    raise exception 'RUNOFF_ALREADY_EXISTS';
end;
$$;

revoke all on function public.create_runoff_election(uuid, uuid[], text, date, date, time, time)
  from public, anon, authenticated;
grant execute on function public.create_runoff_election(uuid, uuid[], text, date, date, time, time)
  to service_role;

-- =========================================================================
-- resolve_parent_ties_from_runoff — o elo que faltava.
--
-- Marca no PAI quem venceu o desempate, sem tocar em votes_count: os votos
-- da eleição original ficam preservados exatamente como foram apurados. O
-- registro em runoff_resolutions é o que torna a decisão auditável — nada
-- de UPDATE anônimo zerando tie_break_needed.
-- =========================================================================
create or replace function public.resolve_parent_ties_from_runoff(p_runoff_election_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_runoff elections%rowtype;
  v_rp record;
  v_seat_offset int;
  v_seat_labels text[];
  v_winner record;
  v_seat_label text;
begin
  select * into v_runoff from elections where id = p_runoff_election_id;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;
  if v_runoff.type <> 'runoff' then
    raise exception 'NOT_A_RUNOFF';
  end if;
  if v_runoff.results_computed_at is null then
    raise exception 'RESULTS_NOT_COMPUTED';
  end if;

  -- Desempate que terminou empatado NÃO é resolvido automaticamente: a
  -- pendência permanece e o administrador cria a rodada seguinte.
  if exists (
    select 1 from result_snapshots
    where election_id = p_runoff_election_id and tie_break_needed = true
  ) then
    raise exception 'TIE_PENDING';
  end if;

  for v_rp in
    select * from runoff_positions
    where runoff_election_id = p_runoff_election_id and resolved_at is null
    for update
  loop
    -- Assentos já definidos no pai — os rótulos do desempate continuam a
    -- numeração (ex.: "Segundo Tesoureiro" depois do primeiro já eleito).
    select count(*) into v_seat_offset
    from result_snapshots
    where election_id = v_runoff.parent_election_id
      and position_id = v_rp.position_id
      and elected = true;

    select seat_labels into v_seat_labels from positions where id = v_rp.position_id;

    for v_winner in
      select candidate_id, votes_count,
             row_number() over (order by votes_count desc) as seat_index
      from result_snapshots
      where election_id = p_runoff_election_id
        and position_id = v_rp.position_id
        and candidate_id is not null
      order by votes_count desc
      limit v_rp.vacancies_in_dispute
    loop
      v_seat_label := null;
      if v_seat_labels is not null
         and (v_seat_offset + v_winner.seat_index) <= array_length(v_seat_labels, 1) then
        v_seat_label := v_seat_labels[v_seat_offset + v_winner.seat_index];
      end if;

      update result_snapshots
      set elected = true, tie_break_needed = false, seat_label = v_seat_label
      where election_id = v_runoff.parent_election_id
        and position_id = v_rp.position_id
        and candidate_id = v_winner.candidate_id;

      insert into runoff_resolutions (
        parent_election_id, runoff_election_id, position_id,
        candidate_id, seat_label, votes_in_runoff
      )
      values (
        v_runoff.parent_election_id, p_runoff_election_id, v_rp.position_id,
        v_winner.candidate_id, v_seat_label, v_winner.votes_count
      );
    end loop;

    -- Quem sobrou do grupo empatado deixa de ser pendência e não é eleito.
    update result_snapshots
    set tie_break_needed = false, elected = false
    where election_id = v_runoff.parent_election_id
      and position_id = v_rp.position_id
      and tie_break_needed = true;

    update runoff_positions set resolved_at = now()
    where runoff_election_id = p_runoff_election_id and position_id = v_rp.position_id;
  end loop;
end;
$$;

revoke all on function public.resolve_parent_ties_from_runoff(uuid) from public, anon, authenticated;
grant execute on function public.resolve_parent_ties_from_runoff(uuid) to service_role;

-- =========================================================================
-- publish_results — publicar um desempate resolve o pai na mesma transação.
--
-- Fazer disso um passo separado deixaria aberta a janela que causou o bug:
-- desempate publicado, pai travado em TIE_PENDING para sempre.
-- =========================================================================
create or replace function public.publish_results(p_election_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_election elections%rowtype;
begin
  select * into v_election from elections where id = p_election_id;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;

  if v_election.results_computed_at is null then
    raise exception 'RESULTS_NOT_COMPUTED';
  end if;

  if exists(select 1 from result_snapshots where election_id = p_election_id and tie_break_needed = true) then
    raise exception 'TIE_PENDING';
  end if;

  if exists(select 1 from position_dual_winner_decisions where election_id = p_election_id and status = 'pending') then
    raise exception 'DUAL_WINNER_PENDING';
  end if;

  if exists(select 1 from elections where parent_election_id = p_election_id and results_published_at is null) then
    raise exception 'RUNOFF_PENDING';
  end if;

  if v_election.type = 'runoff' then
    perform resolve_parent_ties_from_runoff(p_election_id);
  end if;

  update elections set results_published_at = now() where id = p_election_id;

  insert into result_publications (election_id, published_at)
  values (p_election_id, now())
  on conflict (election_id) do update set published_at = excluded.published_at;
end;
$$;

revoke all on function public.publish_results(uuid) from public, anon, authenticated;
grant execute on function public.publish_results(uuid) to service_role;

-- =========================================================================
-- compute_results — desempate multi-cargo.
--
-- Derivada da versão em produção (0008, com denormalização de nome/foto),
-- não da 0005: o laço de cargos passa a vir de runoff_positions e os
-- candidatos elegíveis do desempate são escopados por cargo. O ramo da
-- eleição geral permanece idêntico.
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
    on conflict (election_id, candidate_id) do nothing;
  end if;

  update elections set results_computed_at = now() where id = p_election_id;
end;
$$;
revoke all on function public.compute_results(uuid) from public, anon, authenticated;
grant execute on function public.compute_results(uuid) to service_role;

-- =========================================================================
-- get_current_voting_election — qual eleição está EFETIVAMENTE aberta.
--
-- Determinística e baseada no status autoritativo do Postgres, nunca em
-- "pega o desempate mais recente". Como um desempate cobre todos os cargos
-- empatados de uma vez, no máximo uma eleição fica aberta — e se por algum
-- caminho houver duas, a função falha alto em vez de escolher por conta.
--
-- Pública: o fluxo de /votar precisa dela com a chave anônima. Não devolve
-- nenhum resultado, parcial ou final.
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
        from positions p where p.active = true
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
-- cast_ballot — desempate multi-cargo.
--
-- Mudanças cirúrgicas sobre a versão validada na primeira simulação: os
-- cargos obrigatórios, os votos por eleitor e a checagem de candidato
-- passam a vir de runoff_positions/runoff_candidates quando a eleição é um
-- desempate. Todo o resto (lock da sessão, unicidade por eleição,
-- atomicidade, nulo, soma exata) é idêntico.
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
    select array_agg(id) into v_required_positions from positions where active = true;
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
