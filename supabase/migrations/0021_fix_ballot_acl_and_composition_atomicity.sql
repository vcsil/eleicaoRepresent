-- =========================================================================
-- 0021 — correções de segurança e integridade sobre a 0020.
--
-- Quatro problemas, todos reproduzidos contra o banco antes de corrigir:
--
--  A. `cast_ballot` passou a ser executável por `anon`/`authenticated` na
--     0020. Desde a 0004 ela nunca foi: a única porta de entrada é a
--     Server Action, e é lá que vivem o schema Zod, o tratamento de erro e
--     o registro de evento. Com EXECUTE no papel público, dava para chamar
--     a função direto do navegador, com um token legítimo, e enviar um
--     payload que o Zod recusaria (ele limita `allocations` a 20; a função
--     não tem teto).
--
--  B/C/D. A gravação de candidato fazia leitura de congelamento, DELETE e
--     INSERT em `candidate_positions` como três operações separadas, via
--     PostgREST. Isso abria três janelas: cargos duplicados passavam pela
--     comparação e quebravam no INSERT depois do DELETE; uma edição só de
--     texto apagava e recriava os vínculos, e nesse intervalo um cargo
--     podia deixar de ser disputado e sair da cédula; e a liberação da
--     votação podia acontecer entre a verificação e a escrita.
--
--     `save_candidate` passa a fazer tudo numa transação só, tomando o
--     MESMO lock de `release_voting` na linha da eleição.
--
--  E. `release_voting` não verificava o fim da janela.
--
-- Esta migration não altera nenhum voto, cédula ou resultado gravado.
-- =========================================================================

-- =========================================================================
-- A. cast_ballot volta a ser exclusiva de service_role.
--
-- Não recria a função: só corrige a ACL que a 0020 alargou. O corpo
-- continua sendo o da 0020 (cargos sem disputa não são exigidos).
-- =========================================================================
revoke all on function public.cast_ballot(text, jsonb) from public, anon, authenticated;
grant execute on function public.cast_ballot(text, jsonb) to service_role;


-- =========================================================================
-- Impressão digital da composição.
--
-- Serve à confirmação da liberação: o resumo que o administrador leu pode
-- ter sido montado antes de outra pessoa mexer nos candidatos. A digital é
-- calculada DENTRO da transação de liberação, com a linha da eleição já
-- travada — uma releitura solta não resolveria a corrida.
--
-- Cobre exatamente o que muda a cédula: cargo, vagas, e quais candidatos
-- ativos concorrem a ele.
-- =========================================================================
create or replace function public.composition_digest()
returns text
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select encode(
    digest(
      coalesce(string_agg(linha, '|' order by linha), ''),
      'sha256'
    ),
    'hex'
  )
  from (
    select p.id::text || ':' || p.vacancies::text || ':' ||
           coalesce((
             select string_agg(c.id::text, ',' order by c.id)
             from candidate_positions cp
             join candidates c on c.id = cp.candidate_id
             where cp.position_id = p.id and c.active = true
           ), '') as linha
    from positions p
    where p.active = true
  ) as composicao;
$$;

revoke all on function public.composition_digest() from public, anon, authenticated;
grant execute on function public.composition_digest() to service_role;


-- =========================================================================
-- E + confirmação com composição desatualizada.
--
-- Assinatura nova (dois parâmetros), então a versão de um parâmetro da
-- 0020 é removida — deixar as duas conviveria como sobrecarga ambígua.
-- =========================================================================
drop function if exists public.release_voting(uuid);

create or replace function public.release_voting(
  p_election_id uuid,
  p_expected_digest text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_election elections%rowtype;
  v_votacao record;
begin
  select * into v_election from elections where id = p_election_id for update;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;
  if v_election.type <> 'general' then
    raise exception 'NOT_A_GENERAL_ELECTION';
  end if;

  -- Já liberada: devolve o carimbo existente sem tocar em nada. A digital
  -- NÃO é conferida aqui — a composição legítima já congelou no primeiro
  -- clique, e recusar um reenvio idempotente só produziria um erro que o
  -- administrador não teria como resolver.
  if v_election.voting_released_at is not null then
    return v_election.voting_released_at;
  end if;

  if v_election.voting_closed_manually_at is not null then
    raise exception 'VOTING_ALREADY_CLOSED';
  end if;

  select * into v_votacao from election_phase_bounds(p_election_id, 'votacao');
  if v_votacao.starts_at is null then
    raise exception 'VOTING_WINDOW_NOT_CONFIGURED';
  end if;
  if now() < v_votacao.starts_at then
    raise exception 'VOTING_NOT_STARTED';
  end if;
  -- E: a janela já terminou. Liberar aqui abriria uma urna que
  -- `compute_election_status` já considera encerrada — o administrador
  -- veria "liberado" e o eleitorado, "votação encerrada".
  if v_votacao.ends_at is not null and now() > v_votacao.ends_at then
    raise exception 'VOTING_WINDOW_ENDED';
  end if;

  -- A composição mudou entre montar o resumo e confirmar? O lock acima já
  -- está tomado, então esta comparação e a escrita são indivisíveis.
  if p_expected_digest is not null and p_expected_digest <> composition_digest() then
    raise exception 'COMPOSITION_CHANGED';
  end if;

  update elections set voting_released_at = now() where id = p_election_id;

  select voting_released_at into v_election.voting_released_at
  from elections where id = p_election_id;
  return v_election.voting_released_at;
end;
$$;

revoke all on function public.release_voting(uuid, text) from public, anon, authenticated;
grant execute on function public.release_voting(uuid, text) to service_role;


-- =========================================================================
-- B + C + D. save_candidate — uma transação para toda a gravação.
--
-- Recebe já resolvido o que depende de rede (caminho da foto, URL
-- canônica do vídeo): upload e download de capa acontecem ANTES, fora
-- daqui, para não segurar lock durante chamada externa.
--
-- Regras:
--  - cargos duplicados são recusados antes de qualquer escrita (B);
--  - `candidate_positions` só é tocada quando o CONJUNTO muda (C) — editar
--    só texto ou foto não apaga vínculo nenhum;
--  - a linha da eleição é travada com o mesmo `for update` de
--    `release_voting`, então uma edição concorrente com a liberação ou
--    termina inteira antes dela, ou é recusada (D).
-- =========================================================================
create or replace function public.save_candidate(
  p_candidate_id uuid,
  p_full_name text,
  p_tagline text,
  p_presentation text,
  p_proposals text,
  p_video_url text,
  p_active boolean,
  p_display_order int,
  p_position_ids uuid[],
  p_photo_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_election elections%rowtype;
  v_frozen boolean;
  v_atual candidates%rowtype;
  v_cargos_atuais uuid[];
  v_cargos_novos uuid[];
  v_composicao_mudou boolean;
  v_id uuid;
begin
  -- B: sem cargo, cargo demais, ou o mesmo cargo repetido. A repetição era
  -- o furo: [A,B] contra [A,A] tem o mesmo tamanho e todo item enviado
  -- pertence ao conjunto original, então passava pela comparação e só
  -- quebrava no INSERT — depois do DELETE já ter apagado os vínculos.
  if p_position_ids is null or array_length(p_position_ids, 1) is null then
    raise exception 'INVALID_POSITIONS';
  end if;
  if array_length(p_position_ids, 1) > 2 then
    raise exception 'INVALID_POSITIONS';
  end if;

  select array_agg(distinct t.position_id) into v_cargos_novos
  from unnest(p_position_ids) as t(position_id);

  if array_length(v_cargos_novos, 1) <> array_length(p_position_ids, 1) then
    raise exception 'DUPLICATE_POSITIONS';
  end if;

  -- Alias explícito de propósito: com `unnest(...) as id`, o `id` da
  -- condição resolve para `p.id` (o escopo interno vence), a comparação
  -- vira `p.id = p.id` e a checagem nunca dispara.
  if exists (
    select 1 from unnest(v_cargos_novos) as t(position_id)
    where not exists (
      select 1 from positions p where p.id = t.position_id and p.active = true
    )
  ) then
    raise exception 'INVALID_POSITIONS';
  end if;

  -- D: o MESMO lock que `release_voting` toma. A partir daqui, ou esta
  -- transação termina antes da liberação, ou ela espera por esta.
  select * into v_election from elections
  where type = 'general' order by created_at asc limit 1 for update;

  -- Sem eleição cadastrada não há votação a proteger (instalação nova,
  -- antes do seed).
  v_frozen := found and v_election.voting_released_at is not null;

  if p_candidate_id is null then
    if v_frozen then
      raise exception 'COMPOSITION_FROZEN_CREATE';
    end if;

    insert into candidates (full_name, tagline, presentation, proposals, video_url,
                            active, display_order, photo_path)
    values (p_full_name, p_tagline, p_presentation, p_proposals, p_video_url,
            p_active, p_display_order, p_photo_path)
    returning id into v_id;

    insert into candidate_positions (candidate_id, position_id)
    select v_id, t.position_id from unnest(v_cargos_novos) as t(position_id);

    return v_id;
  end if;

  select * into v_atual from candidates where id = p_candidate_id for update;
  if not found then
    raise exception 'CANDIDATE_NOT_FOUND';
  end if;

  select coalesce(array_agg(position_id order by position_id), '{}'::uuid[])
  into v_cargos_atuais
  from candidate_positions where candidate_id = p_candidate_id;

  -- Igualdade real de conjuntos: mesmo tamanho E mesmos elementos, nos dois
  -- sentidos. Ordem não importa — [A,B] e [B,A] são a mesma composição.
  v_composicao_mudou :=
    v_atual.full_name is distinct from p_full_name
    or v_atual.active is distinct from p_active
    or v_atual.display_order is distinct from p_display_order
    or not (
      v_cargos_atuais <@ v_cargos_novos
      and v_cargos_novos <@ v_cargos_atuais
      and array_length(v_cargos_atuais, 1) is not distinct from array_length(v_cargos_novos, 1)
    );

  if v_frozen and v_composicao_mudou then
    raise exception 'COMPOSITION_FROZEN';
  end if;

  update candidates set
    full_name = p_full_name,
    tagline = p_tagline,
    presentation = p_presentation,
    proposals = p_proposals,
    video_url = p_video_url,
    active = p_active,
    display_order = p_display_order,
    photo_path = coalesce(p_photo_path, photo_path)
  where id = p_candidate_id;

  -- C: só mexe nos vínculos quando o conjunto realmente muda. Antes, toda
  -- gravação apagava e recriava — e no intervalo um cargo podia deixar de
  -- ter disputa, sair da cédula e permitir o registro de um voto
  -- incompleto. Trocar só a apresentação não escreve nada aqui.
  if not (
    v_cargos_atuais <@ v_cargos_novos
    and v_cargos_novos <@ v_cargos_atuais
    and array_length(v_cargos_atuais, 1) is not distinct from array_length(v_cargos_novos, 1)
  ) then
    delete from candidate_positions
    where candidate_id = p_candidate_id and position_id <> all(v_cargos_novos);

    insert into candidate_positions (candidate_id, position_id)
    select p_candidate_id, t.position_id from unnest(v_cargos_novos) as t(position_id)
    on conflict (candidate_id, position_id) do nothing;
  end if;

  return p_candidate_id;
end;
$$;

revoke all on function public.save_candidate(uuid, text, text, text, text, text, boolean, int, uuid[], text)
  from public, anon, authenticated;
grant execute on function public.save_candidate(uuid, text, text, text, text, text, boolean, int, uuid[], text)
  to service_role;


-- =========================================================================
-- D (ativar/inativar). Mesmo lock, mesma transação.
-- =========================================================================
create or replace function public.set_candidate_active(
  p_candidate_id uuid,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_election elections%rowtype;
begin
  select * into v_election from elections
  where type = 'general' order by created_at asc limit 1 for update;

  if found and v_election.voting_released_at is not null then
    raise exception 'COMPOSITION_FROZEN';
  end if;

  update candidates set active = p_active where id = p_candidate_id;
  if not found then
    raise exception 'CANDIDATE_NOT_FOUND';
  end if;
end;
$$;

revoke all on function public.set_candidate_active(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_candidate_active(uuid, boolean) to service_role;


-- =========================================================================
-- Guarda de migração: cargo sem disputa que já recebeu voto.
--
-- Base: a versão da 0020, com uma verificação a mais. Não muda nada para
-- uma eleição nova — depois da liberação a composição congela, e as vagas
-- do cargo não são editáveis por nenhuma tela. A única forma de um cargo
-- "sem disputa" ter escolha registrada é o banco ter votos anteriores à
-- regra, e nesse caso a apuração precisa PARAR e pedir decisão humana em
-- vez de zerar a contagem em silêncio.
-- =========================================================================
create or replace function public.compute_results(p_election_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_election elections%rowtype;
  v_position record;
  v_vacancies int;
  v_elegiveis int;
begin
  select * into v_election from elections where id = p_election_id;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;

  if v_election.results_published_at is not null then
    raise exception 'ALREADY_PUBLISHED';
  end if;

  if not election_voting_closed(p_election_id) then
    raise exception 'VOTING_NOT_CLOSED';
  end if;

  delete from result_snapshots where election_id = p_election_id;

  -- Um desempate pode cobrir vários cargos: a lista sai de runoff_positions,
  -- e não mais da coluna singular elections.runoff_position_id.
  for v_position in
    select rp.position_id as id, rp.votes_per_voter, p.name,
           rp.vacancies_in_dispute as vacancies
    from runoff_positions rp
    join positions p on p.id = rp.position_id
    where v_election.type = 'runoff' and rp.runoff_election_id = p_election_id
    union all
    select p.id, p.votes_per_voter, p.name, p.vacancies
    from positions p
    where v_election.type = 'general' and p.active = true
  loop
    v_vacancies := v_position.vacancies;

    -- Quantos candidatos ativos disputam este cargo. Num desempate a lista
    -- vem de runoff_candidates e a regra de "sem disputa" não se aplica:
    -- um desempate só existe porque houve empate na linha de corte.
    if v_election.type = 'general' then
      select count(*) into v_elegiveis
      from candidate_positions cp
      join candidates c on c.id = cp.candidate_id
      where cp.position_id = v_position.id and c.active = true;
    else
      v_elegiveis := v_vacancies + 1; -- força o caminho de disputa
    end if;

    -- CARGO SEM DISPUTA: candidatos não superam as vagas.
    --
    -- Ninguém votou neste cargo (ele nem apareceu na urna), então não há
    -- contagem a fazer. Os candidatos são declarados eleitos AQUI, na
    -- apuração — não antes — e marcados como `unopposed` para que a tela
    -- não exiba "0 votos" para quem nunca foi votado. Nenhum voto
    -- artificial é criado, e nenhuma linha de nulos: não houve cédula.
    --
    -- Zero candidatos: nenhuma linha, ninguém eleito. As vagas ficam
    -- vazias, e a tela deriva isso de (vagas - eleitos).
    if v_elegiveis <= v_vacancies then
      -- Guarda de integridade: este cargo não deveria ter recebido voto
      -- nenhum (sem disputa, ele nem entra na urna). Se houver escolha
      -- registrada, os dados vêm de antes da regra — uma eleição que já
      -- estava em andamento quando a 0020 foi aplicada. Apurar como "sem
      -- disputa" apagaria a contagem real e o rótulo de assento derivado
      -- dela. Recusa alto, em vez de decidir sozinha o que fazer com voto
      -- de verdade; o procedimento está no README.
      if exists (
        select 1 from ballot_choices bc
        join ballots b on b.id = bc.ballot_id
        where b.election_id = p_election_id and bc.position_id = v_position.id
      ) then
        raise exception 'UNCONTESTED_POSITION_HAS_VOTES';
      end if;

      if v_elegiveis > 0 then
        insert into result_snapshots (
          election_id, position_id, candidate_id, votes_count, rank, elected,
          tie_break_needed, unopposed, candidate_name, candidate_photo_path, position_name
        )
        select
          p_election_id, v_position.id, c.id, 0,
          row_number() over (order by c.display_order, c.full_name),
          true, false, true, c.full_name, c.photo_path, v_position.name
        from candidate_positions cp
        join candidates c on c.id = cp.candidate_id
        where cp.position_id = v_position.id and c.active = true;

        -- Rótulos de assento valem igualmente para quem foi eleito sem
        -- disputa: a vaga ocupada é a mesma.
        update result_snapshots rs
        set seat_label = pos.seat_labels[er.seat_index]
        from (
          select id, row_number() over (order by rank asc) as seat_index
          from result_snapshots
          where election_id = p_election_id and position_id = v_position.id and elected = true
        ) er
        join positions pos on pos.id = v_position.id
        where rs.id = er.id
          and pos.seat_labels is not null
          and er.seat_index <= array_length(pos.seat_labels, 1);
      end if;

      continue;
    end if;

    with eligible_candidates as (
      select cp.candidate_id
      from candidate_positions cp
      join candidates c on c.id = cp.candidate_id
      where v_election.type = 'general' and cp.position_id = v_position.id and c.active = true
      union
      select rc.candidate_id
      from runoff_candidates rc
      where v_election.type = 'runoff' and rc.runoff_election_id = p_election_id
        and rc.position_id = v_position.id
    ),
    vote_counts as (
      select bc.candidate_id, count(*)::int as votes_count
      from ballot_choices bc
      join ballots b on b.id = bc.ballot_id
      where b.election_id = p_election_id
        and bc.position_id = v_position.id
        and bc.is_null_vote = false
      group by bc.candidate_id
    ),
    -- Todo candidato elegível entra no resultado, mesmo com 0 votos
    -- (seção 51 exige mostrar a classificação completa, não só quem votou).
    counts as (
      select ec.candidate_id, coalesce(vc.votes_count, 0) as votes_count
      from eligible_candidates ec
      left join vote_counts vc on vc.candidate_id = ec.candidate_id
    ),
    ranked as (
      select
        candidate_id,
        votes_count,
        rank() over (order by votes_count desc) as rnk,
        count(*) over (partition by votes_count) as tie_group_size
      from counts
    )
    insert into result_snapshots (
      election_id, position_id, candidate_id, votes_count, rank, elected, tie_break_needed,
      candidate_name, candidate_photo_path, position_name
    )
    select
      p_election_id, v_position.id, ranked.candidate_id, ranked.votes_count, ranked.rnk,
      (ranked.rnk <= v_vacancies and (ranked.rnk + ranked.tie_group_size - 1) <= v_vacancies),
      (ranked.rnk <= v_vacancies and (ranked.rnk + ranked.tie_group_size - 1) > v_vacancies),
      c.full_name, c.photo_path, v_position.name
    from ranked
    join candidates c on c.id = ranked.candidate_id;

    insert into result_snapshots (
      election_id, position_id, candidate_id, votes_count, rank, elected, tie_break_needed, position_name
    )
    select
      p_election_id, v_position.id, null,
      count(*) filter (where bc.is_null_vote = true),
      null, false, false, v_position.name
    from ballots b
    left join ballot_choices bc on bc.ballot_id = b.id and bc.position_id = v_position.id
    where b.election_id = p_election_id;

    -- Rótulos de assento só na eleição geral: num desempate eles são
    -- atribuídos ao resolver o pai, continuando a numeração de lá.
    if v_election.type = 'general' then
      update result_snapshots rs
      set seat_label = pos.seat_labels[er.seat_index]
      from (
        select id, row_number() over (order by rank asc) as seat_index
        from result_snapshots
        where election_id = p_election_id and position_id = v_position.id and elected = true
      ) er
      join positions pos on pos.id = v_position.id
      where rs.id = er.id
        and pos.seat_labels is not null
        and er.seat_index <= array_length(pos.seat_labels, 1);
    end if;
  end loop;

  if v_election.type = 'general' then
    insert into position_dual_winner_decisions (election_id, candidate_id, position_id_a, position_id_b)
    select p_election_id, candidate_id, min(position_id::text)::uuid, max(position_id::text)::uuid
    from result_snapshots
    where election_id = p_election_id and elected = true and candidate_id is not null
    group by candidate_id
    having count(distinct position_id) = 2
    on conflict (election_id, candidate_id) where status = 'pending' do nothing;
  end if;

  update elections set results_computed_at = now() where id = p_election_id;
end;
$$;

revoke all on function public.compute_results(uuid) from public, anon, authenticated;
grant execute on function public.compute_results(uuid) to service_role;
