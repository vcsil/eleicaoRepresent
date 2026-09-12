-- Row Level Security — deny by default (seção 73). Nenhuma tabela sensível
-- recebe policy alguma para anon/authenticated; apenas o conteúdo
-- explicitamente público é liberado. Toda escrita (mesmo nas tabelas
-- "públicas") passa exclusivamente pelo cliente service_role em
-- Server Actions/Route Handlers — por isso não há policies de INSERT/
-- UPDATE/DELETE para anon/authenticated em nenhuma tabela.
--
-- Observação: funções SECURITY DEFINER (cast_ballot, compute_results, ...)
-- são de propriedade do papel dono das tabelas e, por padrão, o dono não é
-- restringido por RLS (a menos que FORCE ROW LEVEL SECURITY seja usado, o
-- que deliberadamente NÃO fazemos aqui, pois quebraria essas funções).

alter table positions enable row level security;
alter table elections enable row level security;
alter table election_phases enable row level security;
alter table candidates enable row level security;
alter table candidate_positions enable row level security;
alter table voters enable row level security;
alter table vote_sessions enable row level security;
alter table ballots enable row level security;
alter table ballot_choices enable row level security;
alter table audit_vote_links enable row level security;
alter table result_snapshots enable row level security;
alter table position_dual_winner_decisions enable row level security;
alter table seat_reassignments enable row level security;
alter table runoff_candidates enable row level security;
alter table result_publications enable row level security;
alter table admin_sessions enable row level security;
alter table admin_logs enable row level security;
alter table security_events enable row level security;
alter table rate_limit_counters enable row level security;
alter table site_access_stats enable row level security;

-- Revoga os privilégios amplos padrão do Supabase antes de conceder só o
-- estritamente necessário.
revoke all on all tables in schema public from anon, authenticated;

-- ---------------------------------------------------------------------
-- Conteúdo público (seções 5-9, 17-19): cargos, candidatos, cronograma.
-- ---------------------------------------------------------------------
create policy positions_public_read on positions
  for select to anon, authenticated
  using (active = true);
grant select on positions to anon, authenticated;

create policy elections_public_read on elections
  for select to anon, authenticated
  using (true);
grant select on elections to anon, authenticated;

create policy election_phases_public_read on election_phases
  for select to anon, authenticated
  using (true);
grant select on election_phases to anon, authenticated;

create policy candidates_public_read on candidates
  for select to anon, authenticated
  using (active = true);
grant select on candidates to anon, authenticated;

create policy candidate_positions_public_read on candidate_positions
  for select to anon, authenticated
  using (true);
grant select on candidate_positions to anon, authenticated;

create policy runoff_candidates_public_read on runoff_candidates
  for select to anon, authenticated
  using (true);
grant select on runoff_candidates to anon, authenticated;

-- ---------------------------------------------------------------------
-- Resultados (seções 50-52): só visível a partir da publicação, por
-- eleição. Antes disso, RLS nega qualquer leitura para anon/authenticated.
-- ---------------------------------------------------------------------
create policy result_snapshots_public_read on result_snapshots
  for select to anon, authenticated
  using (
    exists (
      select 1 from elections e
      where e.id = result_snapshots.election_id and e.results_published_at is not null
    )
  );
grant select on result_snapshots to anon, authenticated;

-- ---------------------------------------------------------------------
-- Tudo o mais permanece sem nenhuma policy pública (seções 20, 42-44,
-- 64, 73-74): voters, vote_sessions, ballots, ballot_choices,
-- audit_vote_links, position_dual_winner_decisions, seat_reassignments,
-- result_publications, admin_sessions, admin_logs, security_events,
-- rate_limit_counters, site_access_stats. Nenhum GRANT é concedido a
-- anon/authenticated nessas tabelas — apenas o service_role as acessa,
-- sempre a partir de Server Actions/Route Handlers.
--
-- ---------------------------------------------------------------------
-- service_role (seção 74): só tem o atributo BYPASSRLS (ignora as
-- *policies* de RLS acima), mas continua sujeito à ACL normal de
-- GRANT/REVOKE do Postgres — e, ao contrário de funções (que recebem
-- EXECUTE a PUBLIC por padrão na criação), tabelas não recebem nenhum
-- privilégio a PUBLIC por padrão. Sem este GRANT explícito, todo acesso
-- direto a tabela feito pelo cliente service_role (fora das funções
-- SECURITY DEFINER, que rodam com os privilégios do dono/criador das
-- tabelas, não de service_role) falharia com "permission denied".
-- service_role é o único papel de backend confiável do sistema —
-- GRANT ALL (não só SELECT/INSERT) é intencional, não uma concessão
-- granular por operação.
-- ---------------------------------------------------------------------
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
