-- =========================================================================
-- Importação de eleitores por arquivo (CSV/XLSX).
--
-- Até aqui a lista de eleitores era cadastrada direto no banco, à mão. Esta
-- função dá ao painel uma forma de carregar a lista oficial de uma vez.
--
-- Por que uma RPC em vez de N inserts pelo cliente Supabase: cada insert
-- pelo supabase-js é uma requisição HTTP própria. Uma turma de ~100 alunos
-- viraria ~100 requisições sem transação — e uma falha no meio deixaria a
-- lista pela metade, sem forma limpa de retomar. Aqui é um bloco plpgsql:
-- ou entram todos, ou nenhum.
--
-- Nada de schema novo: `voters.registration_number` já é UNIQUE desde a
-- 0002, e é essa constraint (não o botão da tela) que impede duplicata.
-- =========================================================================

create or replace function public.import_voters(
  p_rows jsonb,
  p_mode text default 'update_existing'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_inserted int := 0;
  v_updated int := 0;
  v_skipped int := 0;
  v_total int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'INVALID_PAYLOAD';
  end if;

  if p_mode not in ('update_existing', 'skip_existing') then
    raise exception 'INVALID_MODE';
  end if;

  v_total := jsonb_array_length(p_rows);
  if v_total = 0 then
    raise exception 'EMPTY_PAYLOAD';
  end if;
  if v_total > 2000 then
    raise exception 'TOO_MANY_ROWS';
  end if;

  -- `on commit drop` só libera a tabela no COMMIT; duas chamadas dentro da
  -- mesma transação (um lote, ou um teste) esbarrariam em "relation already
  -- exists". Em produção cada RPC é uma transação própria, mas depender
  -- disso é frágil.
  drop table if exists tmp_import_voters;

  -- Materializa e normaliza a entrada uma vez. `distinct on` é a rede de
  -- segurança contra duplicata dentro do próprio payload: a interface já
  -- bloqueia esse caso, mas um INSERT com a mesma chave duas vezes no mesmo
  -- comando levantaria "ON CONFLICT DO UPDATE command cannot affect row a
  -- second time" e derrubaria a importação inteira.
  create temporary table tmp_import_voters on commit drop as
  select distinct on (registration_number) registration_number, full_name
  from (
    select
      btrim(row_data ->> 'registration_number') as registration_number,
      btrim(row_data ->> 'full_name') as full_name
    from jsonb_array_elements(p_rows) as row_data
  ) s
  where registration_number is not null and registration_number <> ''
    and full_name is not null and full_name <> '';

  if (select count(*) from tmp_import_voters) = 0 then
    raise exception 'NO_VALID_ROWS';
  end if;

  select count(*) into v_updated
  from tmp_import_voters t
  join voters v on v.registration_number = t.registration_number;

  select count(*) into v_inserted
  from tmp_import_voters t
  left join voters v on v.registration_number = t.registration_number
  where v.id is null;

  if p_mode = 'update_existing' then
    -- `full_name` é o ÚNICO campo atualizado. `active`, `has_voted` e
    -- `voted_at` jamais são tocados: histórico eleitoral não se altera por
    -- planilha, e reativar quem foi desativado é decisão consciente.
    -- `normalized_name` é responsabilidade do trigger voters_normalize_name.
    insert into voters (registration_number, full_name)
    select registration_number, full_name from tmp_import_voters
    on conflict (registration_number) do update
      set full_name = excluded.full_name
      where voters.full_name is distinct from excluded.full_name;
  else
    insert into voters (registration_number, full_name)
    select registration_number, full_name from tmp_import_voters
    on conflict (registration_number) do nothing;
    v_skipped := v_updated;
    v_updated := 0;
  end if;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'skipped', v_skipped
  );
end;
$$;

-- Operação administrativa: jamais alcançável pela chave pública.
revoke all on function public.import_voters(jsonb, text) from public, anon, authenticated;
grant execute on function public.import_voters(jsonb, text) to service_role;
