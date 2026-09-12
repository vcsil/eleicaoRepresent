-- Correção para projetos que já aplicaram 0001-0009. Não invente nada de
-- novo aqui: mesmo corpo de compute_election_status, só com
-- SECURITY DEFINER + search_path; e os GRANTs que faltaram depois de cada
-- REVOKE ALL ... FROM PUBLIC (que também tira o acesso implícito que
-- service_role herdaria de PUBLIC — service_role só ganha BYPASSRLS,
-- ignora *policies* de RLS, mas continua sujeito à ACL normal de
-- GRANT/REVOKE do Postgres).

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

  if v_election.voting_closed_manually_at is not null
     or (v_votacao.starts_at is not null and v_now between v_votacao.starts_at and v_votacao.ends_at) then
    if v_election.voting_closed_manually_at is null then
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

-- GRANTs que faltaram depois de cada REVOKE ALL ... FROM PUBLIC nas
-- migrations anteriores. Todas essas funções são chamadas exclusivamente
-- via createServiceClient() (service_role) a partir de Server Actions.
grant execute on function public.check_and_increment_rate_limit(text, text, int, int, int) to service_role;
grant execute on function public.validate_voter(uuid, text, text, text, text, int) to service_role;
grant execute on function public.cast_ballot(text, jsonb) to service_role;
grant execute on function public.compute_results(uuid) to service_role;
grant execute on function public.publish_results(uuid) to service_role;
grant execute on function public.resolve_dual_winner_decision(uuid, uuid) to service_role;
grant execute on function public.create_runoff_election(uuid, uuid, uuid[], int, int, text, date, date, time, time) to service_role;
grant execute on function public.increment_page_view(text) to service_role;
