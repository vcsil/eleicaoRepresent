-- Contagem agregada de acessos (seção 70) — nunca rastreamento individual.
create or replace function public.increment_page_view(p_path text)
returns void
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  insert into site_access_stats (path, day, views)
  values (p_path, current_date, 1)
  on conflict (path, day) do update set views = site_access_stats.views + 1;
$$;

revoke all on function public.increment_page_view(text) from public, anon, authenticated;
grant execute on function public.increment_page_view(text) to service_role;
