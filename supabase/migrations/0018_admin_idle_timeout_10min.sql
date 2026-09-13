-- =========================================================================
-- Janela de inatividade administrativa: 5 -> 10 minutos.
--
-- O intervalo está hardcoded dentro de check_admin_session (0016) e também
-- existe em lib/admin/session-config.ts. Os dois PRECISAM coincidir: se o
-- cliente achar que tem 10 minutos e o servidor conceder 5, o administrador
-- é deslogado no meio de uma operação, sem aviso.
--
-- Um teste de integração compara este intervalo com
-- ADMIN_IDLE_TIMEOUT_SECONDS e quebra se divergirem — é o que impede a
-- dupla de sair de sincronia na próxima alteração.
--
-- A 0016 NÃO é editada: ela já está aplicada. Esta migration substitui a
-- função e ajusta as sessões vigentes para a janela nova.
-- =========================================================================

create or replace function public.check_admin_session(
  p_token_hash text,
  p_renew boolean default false
)
returns table (session_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  -- O DELETE também serializa com renovações concorrentes. Uma linha já
  -- expirada ou removida pelo logout nunca poderá ser recriada por heartbeat.
  delete from admin_sessions s
   where s.token_hash = p_token_hash
     and s.expires_at <= clock_timestamp();

  if p_renew then
    return query
      update admin_sessions s
         set last_activity_at = clock_timestamp(),
             expires_at = clock_timestamp() + interval '10 minutes'
       where s.token_hash = p_token_hash
         and s.expires_at > clock_timestamp()
      returning s.id, s.expires_at;
  else
    return query
      select s.id, s.expires_at
        from admin_sessions s
       where s.token_hash = p_token_hash
         and s.expires_at > clock_timestamp();
  end if;
end;
$$;

revoke all on function public.check_admin_session(text, boolean) from public, anon, authenticated;
grant execute on function public.check_admin_session(text, boolean) to service_role;

-- Estende quem está logado agora para a janela nova, em vez de deixar
-- sessões com o prazo antigo até o próximo heartbeat.
update admin_sessions
set expires_at = greatest(expires_at, clock_timestamp() + interval '10 minutes')
where expires_at > clock_timestamp();
