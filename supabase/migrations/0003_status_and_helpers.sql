-- Cálculo de status (fonte da verdade — seção 5.2/9) e utilitários de
-- segurança (rate limiting). Tudo baseado em now() do Postgres, nunca no
-- relógio do cliente.

create or replace function public.election_phase_bounds(
  p_election_id uuid,
  p_phase_key text,
  out starts_at timestamptz,
  out ends_at timestamptz,
  out time_configured boolean
)
language sql
stable
as $$
  select
    (ep.starts_on::text || ' ' || ep.start_time::text)::timestamp at time zone 'America/Sao_Paulo',
    (ep.ends_on::text || ' ' || ep.end_time::text)::timestamp at time zone 'America/Sao_Paulo',
    ep.time_configured
  from election_phases ep
  where ep.election_id = p_election_id and ep.phase_key = p_phase_key;
$$;

create or replace function public.compute_election_status(p_election_id uuid)
returns text
language plpgsql
stable
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

-- =========================================================================
-- Rate limiting progressivo (seção 24/61) — sem depender de serviço externo.
-- Retorna true se a tentativa é permitida, false se bloqueada.
-- =========================================================================
create or replace function public.check_and_increment_rate_limit(
  p_scope text,
  p_key_hash text,
  p_window_seconds int default 300,
  p_max_attempts int default 5,
  p_block_seconds int default 120
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_window_start timestamptz;
  v_attempts int;
  v_recent_block timestamptz;
begin
  select blocked_until into v_recent_block
  from rate_limit_counters
  where scope = p_scope and key_hash = p_key_hash
  order by window_start desc
  limit 1;

  if v_recent_block is not null and v_recent_block > now() then
    return false;
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into rate_limit_counters (scope, key_hash, window_start, attempts)
  values (p_scope, p_key_hash, v_window_start, 1)
  on conflict (scope, key_hash, window_start)
  do update set attempts = rate_limit_counters.attempts + 1
  returning attempts into v_attempts;

  if v_attempts > p_max_attempts then
    update rate_limit_counters
    set blocked_until = now() +
      (p_block_seconds * least(v_attempts - p_max_attempts, 6)) * interval '1 second'
    where scope = p_scope and key_hash = p_key_hash and window_start = v_window_start;
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.check_and_increment_rate_limit(text, text, int, int, int) from public, anon, authenticated;
