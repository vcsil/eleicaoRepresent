-- Denormaliza nome/foto do candidato e nome do cargo em result_snapshots.
-- Motivo: a policy pública de "candidates"/"positions" só libera linhas com
-- active = true — se um candidato ou cargo for desativado depois da
-- eleição, a página pública de resultados não deve depender de uma
-- consulta que passaria a negar acesso a esse registro histórico.
alter table result_snapshots
  add column candidate_name text,
  add column candidate_photo_path text,
  add column position_name text;

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
    select id, votes_per_voter, name from
      (select
         case when v_election.type = 'runoff' then v_election.runoff_position_id else p.id end as id,
         case when v_election.type = 'runoff' then v_election.runoff_votes_per_voter else p.votes_per_voter end as votes_per_voter,
         p.name
       from positions p
       where (v_election.type = 'general' and p.active = true)
          or (v_election.type = 'runoff' and p.id = v_election.runoff_position_id)) x
  loop
    v_vacancies := case when v_election.type = 'runoff' then v_election.runoff_vacancies
      else (select vacancies from positions where id = v_position.id) end;

    with eligible_candidates as (
      select cp.candidate_id
      from candidate_positions cp
      join candidates c on c.id = cp.candidate_id
      where v_election.type = 'general' and cp.position_id = v_position.id and c.active = true
      union
      select rc.candidate_id
      from runoff_candidates rc
      where v_election.type = 'runoff' and rc.runoff_election_id = p_election_id
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

-- resolve_dual_winner_decision também precisa preencher os campos
-- denormalizados ao promover o próximo colocado.
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

  update result_snapshots
  set elected = false, seat_label = null
  where election_id = v_decision.election_id
    and position_id = v_vacated_position_id
    and candidate_id = v_decision.candidate_id;

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

revoke all on function public.compute_results(uuid) from public, anon, authenticated;
revoke all on function public.resolve_dual_winner_decision(uuid, uuid) from public, anon, authenticated;
