-- =========================================================================
-- Correção de dois defeitos encontrados na auditoria do HEAD, ambos
-- reproduzidos contra o Postgres antes desta migration.
--
-- 1. Duas votações de desempate abertas ao mesmo tempo tornavam
--    get_current_voting_election() ambígua e derrubavam /votar para TODOS
--    os eleitores — não só para os cargos em disputa.
--
-- 2. A promoção feita ao resolver "candidato eleito em dois cargos" podia
--    deixar o PROMOVIDO acumulando dois cargos, sem nada detectar, e
--    publish_results publicava assim mesmo.
--
-- Nenhuma migration anterior é editada: 0014 e 0008 já estão aplicadas.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Uma mesma pessoa pode precisar escolher entre cargos mais de uma vez ao
-- longo de uma cascata de promoções — por pares de cargos diferentes. A
-- restrição antiga (uma decisão por candidato, para sempre) impediria
-- registrar a segunda. O índice parcial preserva o essencial: nunca duas
-- decisões PENDENTES para a mesma pessoa ao mesmo tempo.
-- -------------------------------------------------------------------------
alter table position_dual_winner_decisions
  drop constraint if exists position_dual_winner_decisions_election_id_candidate_id_key;

create unique index if not exists position_dual_winner_one_pending_per_candidate
  on position_dual_winner_decisions (election_id, candidate_id)
  where status = 'pending';


-- =========================================================================
-- compute_results — acompanha o índice parcial criado acima.
--
-- Byte a byte igual à versão da 0014, com UMA linha alterada: o ON CONFLICT
-- apontava para a constraint (election_id, candidate_id) que esta migration
-- substituiu pelo índice parcial. Sem este ajuste a apuração falharia com
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
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
    on conflict (election_id, candidate_id) where status = 'pending' do nothing;
  end if;

  update elections set results_computed_at = now() where id = p_election_id;
end;
$$;

revoke all on function public.compute_results(uuid) from public, anon, authenticated;
grant execute on function public.compute_results(uuid) to service_role;

-- =========================================================================
-- create_runoff_election — recusa janela sobreposta.
--
-- Idêntica à versão da 0014, com uma checagem a mais. A duplicação por
-- CARGO já era barrada (RUNOFF_ALREADY_EXISTS); o que faltava era barrar
-- duas votações de cargos DIFERENTES acontecendo ao mesmo tempo.
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
    raise exception 'RUNOFF_ALREADY_EXISTS';
end;
$$;

revoke all on function public.create_runoff_election(uuid, uuid[], text, date, date, time, time)
  from public, anon, authenticated;
grant execute on function public.create_runoff_election(uuid, uuid[], text, date, date, time, time)
  to service_role;

-- =========================================================================
-- resolve_dual_winner_decision — detecta a cascata.
--
-- Idêntica à versão da 0008, com um bloco a mais no fim: promover o próximo
-- colocado pode deixá-lo com dois cargos. Quem cria as decisões de cargo
-- duplo é compute_results, que NÃO roda de novo aqui — por isso a cascata
-- passava despercebida e o resultado saía publicado com uma pessoa
-- acumulando dois cargos.
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
  v_promoted_positions int;
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

    -- Cascata: o promovido já podia estar eleito em outro cargo. Nesse caso
    -- ele passa pela MESMA escolha, registrada da mesma forma — nada é
    -- decidido automaticamente.
    select count(distinct position_id) into v_promoted_positions
    from result_snapshots
    where election_id = v_decision.election_id
      and candidate_id = v_promoted_candidate_id
      and elected = true;

    if v_promoted_positions >= 2 then
      insert into position_dual_winner_decisions (election_id, candidate_id, position_id_a, position_id_b)
      select v_decision.election_id, v_promoted_candidate_id,
             min(position_id::text)::uuid, max(position_id::text)::uuid
      from result_snapshots
      where election_id = v_decision.election_id
        and candidate_id = v_promoted_candidate_id
        and elected = true
      on conflict (election_id, candidate_id) where status = 'pending' do nothing;
    end if;
  end if;

  insert into seat_reassignments (election_id, position_id, vacated_by_candidate_id, promoted_candidate_id, reason)
  values (
    v_decision.election_id, v_vacated_position_id, v_decision.candidate_id, v_promoted_candidate_id,
    'Candidato eleito em dois cargos optou por outra posição; vaga preenchida pelo próximo colocado.'
  );
end;
$$;

revoke all on function public.resolve_dual_winner_decision(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_dual_winner_decision(uuid, uuid) to service_role;

-- =========================================================================
-- publish_results — rede de segurança contra acúmulo de cargos.
--
-- Idêntica à versão da 0014, com uma checagem a mais. A checagem por
-- DECISÃO pendente continua; esta olha o RESULTADO em si, e por isso pega
-- qualquer caminho que produza alguém eleito em mais de um cargo — inclusive
-- os três cargos de uma vez, que a detecção por pares não cobre.
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

  if exists (
    select 1 from result_snapshots
    where election_id = p_election_id and elected = true and candidate_id is not null
    group by candidate_id
    having count(distinct position_id) > 1
  ) then
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
