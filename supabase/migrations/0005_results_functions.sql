-- Apuração, publicação, participação e resolução de pendências pós-eleição.
-- Todas SECURITY DEFINER; nenhuma aceita números pré-calculados do cliente
-- (seção 86) — tudo é somado a partir de ballot_choices/audit_vote_links.

create or replace function public.election_voting_closed(p_election_id uuid)
returns boolean
language sql
stable
as $$
  select compute_election_status(p_election_id) in (
    'votacao_encerrada', 'em_apuracao', 'aguardando_divulgacao',
    'desempate_necessario', 'resultado_disponivel'
  );
$$;

-- =========================================================================
-- get_participation_percentage — único dado público durante a votação
-- (seção 47). Nunca expõe linhas de voters/audit_vote_links, só o agregado.
-- =========================================================================
create or replace function public.get_participation_percentage(p_election_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select case when total_count = 0 then 0
    else round(100.0 * voted_count / total_count, 1)
  end
  from (
    select
      (select count(*) from voters where active = true) as total_count,
      (
        select count(*)
        from audit_vote_links al
        join voters v on v.id = al.voter_id
        where al.election_id = p_election_id and v.active = true
      ) as voted_count
  ) s;
$$;

grant execute on function public.get_participation_percentage(uuid) to anon, authenticated;
grant execute on function public.compute_election_status(uuid) to anon, authenticated;

-- =========================================================================
-- compute_results — seções 49, 52, 84-86. Idempotente enquanto não
-- publicado; nunca publica automaticamente.
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

  for v_position in
    select id, votes_per_voter from
      (select case when v_election.type = 'runoff' then v_election.runoff_position_id else p.id end as id,
              case when v_election.type = 'runoff' then v_election.runoff_votes_per_voter else p.votes_per_voter end as votes_per_voter
       from positions p
       where (v_election.type = 'general' and p.active = true)
          or (v_election.type = 'runoff' and p.id = v_election.runoff_position_id)) x
  loop
    v_vacancies := case when v_election.type = 'runoff' then v_election.runoff_vacancies
      else (select vacancies from positions where id = v_position.id) end;

    with counts as (
      select bc.candidate_id, count(*)::int as votes_count
      from ballot_choices bc
      join ballots b on b.id = bc.ballot_id
      where b.election_id = p_election_id
        and bc.position_id = v_position.id
        and bc.is_null_vote = false
      group by bc.candidate_id
    ),
    ranked as (
      select
        candidate_id,
        votes_count,
        rank() over (order by votes_count desc) as rnk,
        count(*) over (partition by votes_count) as tie_group_size
      from counts
    )
    insert into result_snapshots (election_id, position_id, candidate_id, votes_count, rank, elected, tie_break_needed)
    select
      p_election_id, v_position.id, candidate_id, votes_count, rnk,
      (rnk <= v_vacancies and (rnk + tie_group_size - 1) <= v_vacancies),
      (rnk <= v_vacancies and (rnk + tie_group_size - 1) > v_vacancies)
    from ranked;

    insert into result_snapshots (election_id, position_id, candidate_id, votes_count, rank, elected, tie_break_needed)
    select
      p_election_id, v_position.id, null,
      count(*) filter (where bc.is_null_vote = true),
      null, false, false
    from ballots b
    left join ballot_choices bc on bc.ballot_id = b.id and bc.position_id = v_position.id
    where b.election_id = p_election_id;

    -- Rótulos de assento (ex.: "Primeiro Tesoureiro") em ordem de classificação.
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
  end loop;

  -- Candidato eleito em dois cargos (seção 53) — só se aplica a eleições gerais.
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

-- =========================================================================
-- publish_results — seção 50. Bloqueia publicação enquanto houver empate
-- ou candidato eleito em dois cargos sem decisão.
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

  update elections set results_published_at = now() where id = p_election_id;

  insert into result_publications (election_id, published_at)
  values (p_election_id, now())
  on conflict (election_id) do update set published_at = excluded.published_at;
end;
$$;

revoke all on function public.publish_results(uuid) from public, anon, authenticated;

-- =========================================================================
-- resolve_dual_winner_decision — seções 53-54. Promove o próximo colocado
-- não eleito para a vaga liberada.
-- =========================================================================
create or replace function public.resolve_dual_winner_decision(
  p_decision_id uuid,
  p_chosen_position_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_decision position_dual_winner_decisions%rowtype;
  v_vacated_position_id uuid;
  v_promoted_candidate_id uuid;
  v_promoted_snapshot_id uuid;
  v_seat_index int;
  v_seat_labels text[];
begin
  select * into v_decision from position_dual_winner_decisions where id = p_decision_id for update;
  if not found then
    raise exception 'DECISION_NOT_FOUND';
  end if;
  if v_decision.status <> 'pending' then
    raise exception 'DECISION_ALREADY_RESOLVED';
  end if;
  if p_chosen_position_id not in (v_decision.position_id_a, v_decision.position_id_b) then
    raise exception 'INVALID_POSITION';
  end if;

  v_vacated_position_id := case
    when p_chosen_position_id = v_decision.position_id_a then v_decision.position_id_b
    else v_decision.position_id_a
  end;

  update position_dual_winner_decisions
  set status = 'resolved', chosen_position_id = p_chosen_position_id, resolved_at = now()
  where id = p_decision_id;

  -- Libera a vaga no cargo não escolhido.
  update result_snapshots
  set elected = false, seat_label = null
  where election_id = v_decision.election_id
    and position_id = v_vacated_position_id
    and candidate_id = v_decision.candidate_id;

  -- Exclui também quem já declinou esta mesma posição antes (evita
  -- "promover de volta" um candidato que já escolheu outro cargo aqui).
  select candidate_id, id into v_promoted_candidate_id, v_promoted_snapshot_id
  from result_snapshots
  where election_id = v_decision.election_id
    and position_id = v_vacated_position_id
    and candidate_id is not null
    and candidate_id <> v_decision.candidate_id
    and candidate_id not in (
      select vacated_by_candidate_id from seat_reassignments
      where election_id = v_decision.election_id and position_id = v_vacated_position_id
    )
    and elected = false
    and tie_break_needed = false
  order by rank asc
  limit 1;

  if v_promoted_candidate_id is not null then
    select array_length(array_agg(1), 1) into v_seat_index
    from result_snapshots
    where election_id = v_decision.election_id and position_id = v_vacated_position_id and elected = true;
    v_seat_index := coalesce(v_seat_index, 0) + 1;

    select seat_labels into v_seat_labels from positions where id = v_vacated_position_id;

    update result_snapshots
    set elected = true,
        seat_label = case when v_seat_labels is not null and v_seat_index <= array_length(v_seat_labels, 1)
          then v_seat_labels[v_seat_index] else seat_label end
    where id = v_promoted_snapshot_id;
  end if;

  insert into seat_reassignments (election_id, position_id, vacated_by_candidate_id, promoted_candidate_id, reason)
  values (
    v_decision.election_id, v_vacated_position_id, v_decision.candidate_id, v_promoted_candidate_id,
    'Candidato eleito em dois cargos optou por outra posição; vaga preenchida pelo próximo colocado.'
  );
end;
$$;

revoke all on function public.resolve_dual_winner_decision(uuid, uuid) from public, anon, authenticated;

-- =========================================================================
-- create_runoff_election — seção 56. Cria a eleição de desempate vinculada
-- à eleição principal, já com a fase de votação configurada.
-- =========================================================================
create or replace function public.create_runoff_election(
  p_parent_election_id uuid,
  p_position_id uuid,
  p_candidate_ids uuid[],
  p_votes_per_voter int,
  p_vacancies int,
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
  v_runoff_id uuid;
  v_candidate_id uuid;
begin
  insert into elections (
    type, parent_election_id, name, runoff_position_id,
    runoff_votes_per_voter, runoff_vacancies, runoff_reason
  )
  select
    'runoff', p_parent_election_id,
    'Desempate — ' || p.name || ' — ' || coalesce(p_reason, ''),
    p_position_id, p_votes_per_voter, p_vacancies, p_reason
  from positions p where p.id = p_position_id
  returning id into v_runoff_id;

  foreach v_candidate_id in array p_candidate_ids loop
    insert into runoff_candidates (runoff_election_id, candidate_id) values (v_runoff_id, v_candidate_id);
  end loop;

  insert into election_phases (election_id, phase_key, label, starts_on, ends_on, start_time, end_time, time_configured, display_order)
  values (v_runoff_id, 'votacao', 'Votação de desempate', p_starts_on, p_ends_on, p_start_time, p_end_time, true, 1);

  return v_runoff_id;
end;
$$;

revoke all on function public.create_runoff_election(uuid, uuid, uuid[], int, int, text, date, date, time, time) from public, anon, authenticated;
