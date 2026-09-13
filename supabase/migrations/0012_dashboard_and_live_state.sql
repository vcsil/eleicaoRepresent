-- =========================================================================
-- Consolidação de leituras em round trips únicos (segundo deploy, etapa 1B).
--
-- Duas funções, com públicos-alvo deliberadamente diferentes:
--
--   get_admin_dashboard_metrics — ADMIN ONLY. Substitui 7 consultas
--     paralelas do painel por uma. Duas delas traziam TODAS as linhas de
--     security_events e de site_access_stats para contar/somar em
--     JavaScript — custo que crescia sem limite com o uso do site. Aqui a
--     agregação acontece no Postgres.
--
--   get_live_election_state — PÚBLICA. Alimenta o polling da home durante
--     a votação. Expõe exatamente o que a home já exibia em server render:
--     status + participação + hora do servidor. Nada além disso.
--
-- Nenhuma das duas decide nada: o acesso à urna continua sendo autorizado
-- por validate_voter/cast_ballot no servidor. Status continua calculado a
-- cada chamada (nunca cacheado) porque depende de now() do Postgres.
-- =========================================================================

-- =========================================================================
-- get_admin_dashboard_metrics — restrita a service_role.
--
-- Agrega em uma passada o que o painel mostra. Inclui participação
-- (diferente da função pública, que só a devolve durante a votação): o
-- admin precisa do número em qualquer fase, e esta função nunca é
-- alcançável por anon/authenticated.
-- =========================================================================
create or replace function public.get_admin_dashboard_metrics(p_election_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'status', compute_election_status(p_election_id),
    'participation', get_participation_percentage(p_election_id),
    'server_time', now(),
    'total_voters', (select count(*) from voters where active = true),
    'total_candidates', (select count(*) from candidates where active = true),
    'total_site_views', (select coalesce(sum(views), 0) from site_access_stats),
    'security_events', (select count(*) from security_events),
    'invalid_attempts', (
      select count(*) from security_events where type = 'INVALID_VOTER_VALIDATION'
    ),
    'duplicate_vote_attempts', (
      select count(*) from security_events where type = 'DUPLICATE_VOTE_ATTEMPT'
    ),
    'validation_attempts', (
      select count(*) from security_events
      where type in ('INVALID_VOTER_VALIDATION', 'DUPLICATE_VOTE_ATTEMPT')
    ),
    'ties_pending', (
      select count(*) from result_snapshots
      where election_id = p_election_id and tie_break_needed = true
    ),
    'dual_winners_pending', (
      select count(*) from position_dual_winner_decisions
      where election_id = p_election_id and status = 'pending'
    ),
    'results_computed', (
      select results_computed_at is not null from elections where id = p_election_id
    ),
    'results_published', (
      select results_published_at is not null from elections where id = p_election_id
    )
  );
$$;

-- Dados administrativos: nunca alcançáveis pelo browser. anon e
-- authenticated são os papéis que a chave pública do Supabase assume, então
-- o REVOKE abaixo é o que impede que alguém com a anon key leia contagens
-- de eventos de segurança. (Funções, ao contrário de tabelas, recebem
-- EXECUTE a PUBLIC por padrão na criação — daí o revoke explícito.)
revoke all on function public.get_admin_dashboard_metrics(uuid) from public, anon, authenticated;
grant execute on function public.get_admin_dashboard_metrics(uuid) to service_role;

-- =========================================================================
-- get_live_election_state — pública, para o polling da home.
--
-- Participação só sai durante a votação (seção 47: é o único indicador
-- público de andamento, e só enquanto a votação corre). Fora desse
-- período devolve null — mesma regra que a home já aplicava ao renderizar.
--
-- server_time existe para o countdown corrigir relógio desregulado no
-- browser. É DISPLAY ONLY: nada no sistema autoriza voto com base em hora
-- vinda do cliente.
--
-- Nenhum resultado, parcial ou final, transita por aqui.
-- =========================================================================
create or replace function public.get_live_election_state(p_election_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'status', s.status,
    'participation', case
      when s.status in ('votacao_em_andamento', 'votacao_desempate')
        then get_participation_percentage(p_election_id)
      else null
    end,
    'server_time', now()
  )
  from (select compute_election_status(p_election_id) as status) s;
$$;

revoke all on function public.get_live_election_state(uuid) from public;
grant execute on function public.get_live_election_state(uuid) to anon, authenticated, service_role;
