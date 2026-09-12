-- Schema principal. Ver docs/TECHNICAL_DESIGN.md seções 4-7 para o racional
-- de cada tabela e decisão de modelagem.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =========================================================================
-- Conteúdo eleitoral
-- =========================================================================

create table positions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  vacancies int not null check (vacancies > 0),
  votes_per_voter int not null check (votes_per_voter > 0),
  seat_labels text[],
  description text,
  responsibilities text,
  profile text,
  icon text,
  display_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seat_labels_length check (
    seat_labels is null or array_length(seat_labels, 1) <= vacancies
  )
);
create trigger positions_set_updated_at before update on positions
  for each row execute function set_updated_at();

create table elections (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'general' check (type in ('general', 'runoff')),
  parent_election_id uuid references elections(id),
  name text not null,
  -- Preenchidos apenas quando type = 'runoff' (seção 56): a votação de
  -- desempate cobre uma única posição e tem sua própria quantidade de
  -- votos por eleitor, definida pelo administrador ao criá-la.
  runoff_position_id uuid references positions(id),
  runoff_votes_per_voter int,
  runoff_vacancies int,
  runoff_reason text,
  voting_closed_manually_at timestamptz,
  results_computed_at timestamptz,
  results_published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint runoff_requires_parent check (
    (type = 'general' and parent_election_id is null and runoff_position_id is null and runoff_votes_per_voter is null) or
    (type = 'runoff' and parent_election_id is not null and runoff_position_id is not null
      and runoff_votes_per_voter > 0 and runoff_vacancies > 0)
  )
);
create trigger elections_set_updated_at before update on elections
  for each row execute function set_updated_at();

create table election_phases (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references elections(id) on delete cascade,
  phase_key text not null check (phase_key in (
    'edital', 'candidaturas', 'divulgacao_candidaturas', 'apresentacao',
    'envio_videos', 'votacao', 'apuracao', 'divulgacao_resultados'
  )),
  label text not null,
  starts_on date not null,
  ends_on date not null,
  start_time time not null default '00:00:00',
  end_time time not null default '23:59:59',
  time_configured boolean not null default false,
  display_order int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (election_id, phase_key),
  constraint phase_date_order check (ends_on >= starts_on)
);
create trigger election_phases_set_updated_at before update on election_phases
  for each row execute function set_updated_at();

create table candidates (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  photo_path text,
  tagline text,
  presentation text,
  proposals text,
  video_url text check (
    video_url is null or
    video_url ~ '^https://(www\.)?youtube\.com/|^https://youtu\.be/'
  ),
  active boolean not null default true,
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger candidates_set_updated_at before update on candidates
  for each row execute function set_updated_at();

create table candidate_positions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  position_id uuid not null references positions(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (candidate_id, position_id)
);
create index candidate_positions_position_idx on candidate_positions (position_id);

-- Regra: no máximo 2 cargos por candidato (seção 16).
create or replace function public.enforce_candidate_max_two_positions()
returns trigger
language plpgsql
as $$
declare
  v_count int;
begin
  select count(*) into v_count
  from candidate_positions
  where candidate_id = new.candidate_id;

  if v_count >= 2 then
    raise exception 'CANDIDATE_MAX_TWO_POSITIONS'
      using detail = 'Um candidato pode concorrer a no máximo 2 cargos.';
  end if;

  return new;
end;
$$;

create trigger candidate_positions_max_two
  before insert on candidate_positions
  for each row execute function enforce_candidate_max_two_positions();

-- =========================================================================
-- Eleitores e sessão de votação
-- =========================================================================

create or replace function public.normalize_name(p_name text)
returns text
language sql
immutable
as $$
  select trim(
    regexp_replace(
      lower(extensions.unaccent(coalesce(p_name, ''))),
      '\s+', ' ', 'g'
    )
  );
$$;

create table voters (
  id uuid primary key default gen_random_uuid(),
  registration_number text not null unique,
  full_name text not null,
  normalized_name text not null,
  active boolean not null default true,
  has_voted boolean not null default false,
  voted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index voters_normalized_name_idx on voters (normalized_name);
create trigger voters_set_updated_at before update on voters
  for each row execute function set_updated_at();

create or replace function public.voters_set_normalized_name()
returns trigger
language plpgsql
as $$
begin
  new.normalized_name = normalize_name(new.full_name);
  return new;
end;
$$;

create trigger voters_normalize_name
  before insert or update of full_name on voters
  for each row execute function voters_set_normalized_name();

create table vote_sessions (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references elections(id) on delete cascade,
  voter_id uuid not null references voters(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  ip_hash text,
  user_agent_summary text
);
create index vote_sessions_voter_election_idx on vote_sessions (voter_id, election_id);
create index vote_sessions_expires_idx on vote_sessions (expires_at);

-- =========================================================================
-- Voto (modelagem individual por slot — seção 46)
-- =========================================================================

create table ballots (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references elections(id),
  created_at timestamptz not null default now(),
  submitted_at timestamptz not null default now()
);
create index ballots_election_idx on ballots (election_id);

create table ballot_choices (
  id uuid primary key default gen_random_uuid(),
  ballot_id uuid not null references ballots(id) on delete cascade,
  position_id uuid not null references positions(id),
  candidate_id uuid references candidates(id),
  is_null_vote boolean not null default false,
  vote_slot int not null check (vote_slot > 0),
  created_at timestamptz not null default now(),
  constraint ballot_choices_null_or_candidate check (
    (is_null_vote = true and candidate_id is null) or
    (is_null_vote = false and candidate_id is not null)
  ),
  unique (ballot_id, position_id, vote_slot)
);
create index ballot_choices_ballot_idx on ballot_choices (ballot_id);
create index ballot_choices_position_candidate_idx on ballot_choices (position_id, candidate_id);

-- =========================================================================
-- Camada de auditoria isolada (seções 42-44) — único vínculo eleitor→voto.
-- =========================================================================

create table audit_vote_links (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references elections(id),
  voter_id uuid not null references voters(id),
  ballot_id uuid not null references ballots(id),
  created_at timestamptz not null default now(),
  unique (election_id, voter_id),
  unique (ballot_id)
);
create index audit_vote_links_election_idx on audit_vote_links (election_id);

-- =========================================================================
-- Resultados e desempates
-- =========================================================================

create table result_snapshots (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references elections(id) on delete cascade,
  position_id uuid not null references positions(id),
  candidate_id uuid references candidates(id),
  votes_count int not null check (votes_count >= 0),
  rank int,
  elected boolean not null default false,
  tie_break_needed boolean not null default false,
  seat_label text,
  computed_at timestamptz not null default now()
);
create index result_snapshots_election_position_idx on result_snapshots (election_id, position_id);

create table position_dual_winner_decisions (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references elections(id),
  candidate_id uuid not null references candidates(id),
  position_id_a uuid not null references positions(id),
  position_id_b uuid not null references positions(id),
  status text not null default 'pending' check (status in ('pending', 'resolved')),
  chosen_position_id uuid references positions(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (election_id, candidate_id)
);

create table seat_reassignments (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references elections(id),
  position_id uuid not null references positions(id),
  vacated_by_candidate_id uuid not null references candidates(id),
  promoted_candidate_id uuid references candidates(id),
  reason text not null,
  created_at timestamptz not null default now()
);

create table runoff_candidates (
  runoff_election_id uuid not null references elections(id) on delete cascade,
  candidate_id uuid not null references candidates(id),
  primary key (runoff_election_id, candidate_id)
);

create table result_publications (
  id uuid primary key default gen_random_uuid(),
  election_id uuid not null references elections(id) unique,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

-- =========================================================================
-- Administração e segurança
-- =========================================================================

create table admin_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip_hash text
);
create index admin_sessions_expires_idx on admin_sessions (expires_at);

create table admin_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  actor text not null default 'admin_session',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index admin_logs_created_idx on admin_logs (created_at desc);

create table security_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  ip_hash text,
  user_agent_summary text,
  route text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index security_events_type_created_idx on security_events (type, created_at desc);

create table rate_limit_counters (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  key_hash text not null,
  window_start timestamptz not null,
  attempts int not null default 1,
  blocked_until timestamptz,
  unique (scope, key_hash, window_start)
);
create index rate_limit_counters_lookup_idx on rate_limit_counters (scope, key_hash, window_start desc);

create table site_access_stats (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  day date not null,
  views int not null default 1,
  unique (path, day)
);
