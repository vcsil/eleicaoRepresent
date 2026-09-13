-- =========================================================================
-- A home passa a acompanhar a votação EFETIVAMENTE aberta (etapa 2B).
--
-- Antes, get_live_election_state olhava só para a eleição pedida (a geral).
-- Com um desempate em andamento, a home ficava dizendo "Desempate
-- necessário" — verdade sobre a eleição principal, mas inútil para quem
-- precisa votar: nenhum caminho para a urna aparecia.
--
-- Agora, havendo votação aberta (geral ou desempate), o estado devolvido é
-- o dela. Sem votação aberta, o comportamento é idêntico ao anterior.
--
-- Continua sem expor resultado algum: status, participação e hora.
-- =========================================================================
create or replace function public.get_live_election_state(p_election_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_active jsonb;
  v_target uuid;
  v_status text;
begin
  v_active := get_current_voting_election();

  if v_active is not null then
    v_target := (v_active ->> 'election_id')::uuid;
  else
    v_target := p_election_id;
  end if;

  v_status := compute_election_status(v_target);

  return jsonb_build_object(
    'status', v_status,
    -- Participação só durante a votação (seção 47), e da eleição que está
    -- de fato acontecendo.
    'participation', case
      when v_status in ('votacao_em_andamento', 'votacao_desempate')
        then get_participation_percentage(v_target)
      else null
    end,
    'server_time', now(),
    -- Deixa explícito para a interface QUAL eleição está aberta, para a
    -- home poder direcionar sem adivinhar.
    'active_election_id', case when v_active is null then null else v_target end
  );
end;
$$;

revoke all on function public.get_live_election_state(uuid) from public;
grant execute on function public.get_live_election_state(uuid) to anon, authenticated, service_role;

-- =========================================================================
-- Origem da eleição no resultado público.
--
-- Quem foi eleito por desempate aparece assim em /resultados, junto com os
-- votos das duas rodadas. Mesma regra de visibilidade dos demais
-- resultados: só depois que a eleição principal é publicada.
-- =========================================================================
create policy runoff_resolutions_public_read on runoff_resolutions
  for select to anon, authenticated
  using (
    exists (
      select 1 from elections e
      where e.id = runoff_resolutions.parent_election_id
        and e.results_published_at is not null
    )
  );
grant select on runoff_resolutions to anon, authenticated;
