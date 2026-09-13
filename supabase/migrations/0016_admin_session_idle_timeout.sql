-- Janela deslizante de inatividade para as sessões administrativas.
alter table admin_sessions
  add column last_activity_at timestamptz;

update admin_sessions
set last_activity_at = now(),
    expires_at = now() + interval '5 minutes';

alter table admin_sessions
  alter column last_activity_at set default now(),
  alter column last_activity_at set not null;

create or replace function check_admin_session(
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
             expires_at = clock_timestamp() + interval '5 minutes'
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

revoke all on function check_admin_session(text, boolean) from public, anon, authenticated;
grant execute on function check_admin_session(text, boolean) to service_role;

