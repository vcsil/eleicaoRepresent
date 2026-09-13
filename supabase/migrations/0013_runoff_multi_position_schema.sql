-- =========================================================================
-- Desempate: schema (etapa 2A).
--
-- O modelo anterior assumia UM cargo por desempate (elections.runoff_position_id).
-- Com empates simultâneos em cargos diferentes, isso obrigaria a criar uma
-- eleição por cargo — e então o eleitor precisaria de uma sessão e uma
-- cédula por cargo, perdendo a atomicidade que cast_ballot garante hoje.
--
-- Aqui um desempate passa a cobrir N cargos, exatamente como a eleição
-- geral: uma sessão, uma cédula, um audit_vote_links. Como consequência,
-- no máximo uma eleição fica aberta por vez, o que torna a resolução da
-- "eleição ativa" inequívoca.
--
-- Migration aditiva: não altera nenhuma linha de voto existente.
-- =========================================================================

-- Cargos em disputa em um desempate, com as vagas realmente em jogo.
--
-- `vacancies_in_dispute` é DERIVADO pela apuração (vagas do cargo menos os
-- já eleitos), nunca digitado: um erro de digitação aqui mudaria o
-- resultado eleitoral.
--
-- `parent_election_id` é denormalizado de propósito — é o que permite o
-- índice parcial abaixo impedir dois desempates abertos para o mesmo cargo.
create table runoff_positions (
  runoff_election_id uuid not null references elections(id) on delete cascade,
  parent_election_id uuid not null references elections(id),
  position_id uuid not null references positions(id),
  vacancies_in_dispute int not null check (vacancies_in_dispute > 0),
  votes_per_voter int not null check (votes_per_voter > 0),
  resolved_at timestamptz,
  primary key (runoff_election_id, position_id)
);

create index runoff_positions_parent_idx on runoff_positions (parent_election_id);

-- Proteção contra duplo clique em "criar votação de desempate": no banco,
-- não no botão. Dois desempates abertos para o mesmo cargo travariam a
-- publicação do pai para sempre (publish_results exige TODO filho publicado).
create unique index runoff_positions_one_unresolved_per_parent_position
  on runoff_positions (parent_election_id, position_id)
  where resolved_at is null;

-- Candidatos passam a ser por cargo: um desempate multi-cargo tem um
-- conjunto distinto de empatados em cada um.
alter table runoff_candidates add column position_id uuid references positions(id);

update runoff_candidates rc
set position_id = e.runoff_position_id
from elections e
where e.id = rc.runoff_election_id and rc.position_id is null;

alter table runoff_candidates alter column position_id set not null;
alter table runoff_candidates drop constraint runoff_candidates_pkey;
alter table runoff_candidates add primary key (runoff_election_id, position_id, candidate_id);

-- Registro auditável de cada vaga resolvida por desempate.
--
-- A resolução não pode ser um UPDATE anônimo em result_snapshots: é preciso
-- saber, depois, qual votação decidiu qual vaga. Também dá idempotência —
-- resolver duas vezes esbarra na unique.
create table runoff_resolutions (
  id uuid primary key default gen_random_uuid(),
  parent_election_id uuid not null references elections(id),
  runoff_election_id uuid not null references elections(id),
  position_id uuid not null references positions(id),
  candidate_id uuid not null references candidates(id),
  seat_label text,
  votes_in_runoff int not null check (votes_in_runoff >= 0),
  resolved_at timestamptz not null default now(),
  unique (parent_election_id, position_id, candidate_id)
);

create index runoff_resolutions_parent_idx on runoff_resolutions (parent_election_id);

-- O CHECK antigo exigia runoff_position_id/runoff_votes_per_voter em todo
-- desempate. Num desempate multi-cargo esses valores vivem em
-- runoff_positions; as colunas ficam para trás apenas como histórico.
alter table elections drop constraint runoff_requires_parent;
alter table elections add constraint runoff_requires_parent check (
  (type = 'general' and parent_election_id is null and runoff_position_id is null
     and runoff_votes_per_voter is null)
  or (type = 'runoff' and parent_election_id is not null)
);

-- RLS: deny-by-default como o resto do schema (0006). Nenhuma leitura
-- pública direta — o público vê desempate através de result_snapshots
-- publicados, que já têm policy própria.
alter table runoff_positions enable row level security;
alter table runoff_resolutions enable row level security;

grant all on table runoff_positions to service_role;
grant all on table runoff_resolutions to service_role;
