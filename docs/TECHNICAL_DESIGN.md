# Documento Técnico — Sistema de Eleição da Comissão de Formatura (Turma 36 — Medicina UniEVANGÉLICA)

Status: **proposta para aprovação**. Nenhum código de aplicação foi escrito ainda — conforme o próprio processo solicitado (seção 101 do prompt mestre), este documento precede a implementação. Seções marcadas com ⚠️ **DECISÃO PENDENTE** descrevem pontos em que fiz uma escolha razoável de engenharia (não uma regra eleitoral inventada) e que preciso que você confirme ou ajuste antes de começar a implementar.

---

## 1. Arquitetura

- **Next.js 14+ (App Router) + TypeScript**, deploy recomendado em runtime Node.js serverless (Vercel ou equivalente) com **uma única região** fixada (ex.: `gru1`/São Paulo) para reduzir variação de latência/tempo entre servidor e banco — importante porque toda autorização sensível depende do relógio do servidor.
- **Supabase** como Postgres gerenciado + Storage. Dois clientes distintos:
  - **Cliente anônimo (`anon key`)**: usado apenas em Server Components para leituras públicas permitidas por RLS (posições, candidatos ativos, fases da eleição, status público, percentual de participação, resultados já publicados).
  - **Cliente com `service_role`**: usado **exclusivamente em Server Actions / Route Handlers**, nunca exposto ao bundle do cliente. Todas as operações sensíveis (validação de eleitor, envio de voto, login admin, apuração, publicação) passam por aqui.
- **Nenhuma SPA client-side para lógica sensível.** Componentes de cliente existem só para interatividade local (contadores +/-, navegação entre etapas, modais). Todo envio definitivo é Server Action/Route Handler.
- **Funções Postgres `SECURITY DEFINER`** para as operações atômicas críticas (`cast_ballot`, `cast_runoff_ballot`, `publish_results`, `compute_results`) — a transação completa (lock do eleitor, validações, inserts, marcação de `has_voted`) roda dentro do Postgres, não como múltiplas chamadas sequenciais do Node, eliminando race conditions por design.
- **Fonte única da verdade de tempo**: todas as decisões de fase/autorização usam `now()` do Postgres (via as funções SQL) ou `new Date()` do processo Node do servidor — nunca o relógio do navegador. O cronômetro no cliente é só visual e é resincronizado periodicamente com o servidor.

## 2. Estrutura de Pastas

```
app/
  (public)/
    page.tsx                      -> /
    cargos/page.tsx               -> /cargos
    candidatos/page.tsx           -> /candidatos
    votar/page.tsx                -> /votar (formulário de validação)
    votar/urna/page.tsx           -> /votar/urna (etapas de distribuição)
    votar/revisao/page.tsx        -> /votar/revisao
    voto-confirmado/page.tsx      -> /voto-confirmado
    resultados/page.tsx           -> /resultados
  admin/
    page.tsx                      -> /admin (login)
    (protected)/
      layout.tsx                  -> valida cookie de sessão admin
      dashboard/page.tsx
      candidatos/page.tsx         -> /admin/candidatos
      cronograma/page.tsx         -> /admin/cronograma
      votacao/page.tsx            -> /admin/votacao
      resultados/page.tsx         -> /admin/resultados
      seguranca/page.tsx          -> /admin/seguranca
      desempates/page.tsx         -> /admin/desempates
  api/
    vote/validate/route.ts
    vote/submit/route.ts
    admin/login/route.ts
    admin/logout/route.ts
    admin/candidates/route.ts (+ [id]/route.ts)
    admin/schedule/route.ts
    admin/election/[action]/route.ts   (abrir/encerrar/apurar/publicar)
    admin/runoffs/route.ts
    uploads/candidate-photo/route.ts

components/
  layout/        Header, Footer
  election/      ElectionStatus, Countdown, ElectionTimeline, ParticipationProgress
  positions/     PositionCard, PositionDetailSheet
  candidates/    CandidateCard, CandidateDrawer, YouTubePlayer, CandidateFilterBar
  vote/          VoteStep, VoteProgress, VoteDistributionCard, VoteCounter,
                 VoteReview, ConfirmationDialog
  admin/         AdminSidebar, MetricCard, SecurityEventTable, ActivityTable
  feedback/      EmptyState, LoadingState, ErrorState, Toast

lib/
  supabase/      server.ts (anon, RSC), service.ts (service_role, server-only)
  election/      status.ts (cálculo de fase/status), phases.ts
  security/      normalize-name.ts, rate-limit.ts, hashing.ts, ip.ts
  validation/    schemas/*.ts (Zod: voter, ballot, admin, candidate, schedule...)
  admin/         session.ts (cookie HttpOnly), audit-log.ts

types/           database.ts (tipos gerados do schema), domain.ts

supabase/
  migrations/    0001_init.sql, 0002_..., ...
  seed.sql       (cronograma oficial, posições, valores iniciais)

docs/
  TECHNICAL_DESIGN.md  (este documento)

tests/ (ou *.test.ts colocalizados)
  unit/       normalização, cálculo de status, validação Zod
  integration/  Server Actions contra um Postgres de teste (Supabase local)
  e2e/        fluxo completo de votação (Playwright)
```

## 3. Fluxo da Aplicação

### 3.1 Eleitor
`/` → `/cargos` / `/candidatos` (a qualquer momento) → quando `status = votação em andamento`: botão "Votar agora" → `/votar` (matrícula + nome) → Server Action valida → sessão de votação (cookie) → `/votar/urna` (6 etapas, uma por cargo, com progress bar) → `/votar/revisao` (resumo editável, "Alterar" volta para a etapa) → confirmação dupla → Server Action `submit` (transação atômica) → invalida sessão → `/voto-confirmado` (rota só acessível com um *flag* de sucesso de curta duração, não reacessível por refresh).

### 3.2 Administrador
`/admin` (senha) → cookie de sessão admin (`HttpOnly`, `Secure`, `SameSite=Strict`) → `/admin/dashboard` → CRUD de candidatos, configuração de cronograma (datas vêm do banco, horários editáveis), abertura/encerramento de votação, apuração interna, resolução de empates/desempates, resolução de candidato eleito em dois cargos, liberação de resultados — todas ações sensíveis com diálogo de confirmação e registro em `admin_logs`.

### 3.3 Cálculo de status (servidor)
Uma função `computeElectionStatus(now)` lê `election_phases` (datas/horas configuradas) + flags de `elections` (`voting_closed_manually`, `results_computed_at`, `results_published_at`, `tie_pending`) e deriva o status enumerado da seção 5.2. Essa função roda em Server Components (para render) e dentro das funções SQL (para autorizar ações) — a mesma lógica, nunca duplicada de forma divergente: a versão SQL é a autoritativa para decisões de **autorização**; a versão TS é usada só para **exibição** e deve replicar exatamente as mesmas regras (testada com os mesmos casos).

## 4–7. Schema PostgreSQL, Relacionamentos, Constraints, Índices

> Convenções: `uuid` via `gen_random_uuid()`, timestamps `timestamptz`, `created_at/updated_at` em todas as tabelas operacionais, triggers `updated_at`.

### 4.1 Conteúdo eleitoral

```sql
-- elections: normalmente 1 linha para a eleição principal; desempates viram
-- outras linhas com type = 'runoff' e parent_election_id preenchido.
elections (
  id uuid pk,
  type text not null check (type in ('general','runoff')),
  parent_election_id uuid null references elections(id),
  name text not null,
  voting_closed_manually_at timestamptz null,
  results_computed_at timestamptz null,     -- apuração interna concluída
  results_published_at timestamptz null,    -- liberação pública
  created_at, updated_at
)

election_phases (
  id uuid pk,
  election_id uuid not null references elections(id) on delete cascade,
  phase_key text not null check (phase_key in (
    'edital','candidaturas','divulgacao_candidaturas','apresentacao',
    'envio_videos','votacao','apuracao','divulgacao_resultados'
  )),
  starts_on date not null,
  ends_on date not null,
  start_time time null,   -- NULL até o admin configurar (seção 7: "não inventar horários")
  end_time time null,
  display_order int not null,
  unique (election_id, phase_key),
  created_at, updated_at
)
-- starts_at/ends_at efetivos = (starts_on/ends_on + start_time/end_time).
-- Enquanto start_time/end_time de uma fase crítica (votacao) estiver NULL,
-- o sistema NUNCA autoriza a transição automática para aquela fase — ver
-- decisão pendente (D1).

positions (
  id uuid pk,
  slug text unique not null,           -- presidente, vice_presidente, tesouraria, ...
  name text not null,
  vacancies int not null check (vacancies > 0),
  votes_per_voter int not null check (votes_per_voter > 0),
  seat_labels text[] null,             -- ex.: ['Primeiro Tesoureiro','Segundo Tesoureiro']
  display_order int not null,
  active boolean not null default true,
  created_at, updated_at
)

candidates (
  id uuid pk,
  full_name text not null,
  photo_path text null,                -- caminho no Supabase Storage, não URL pública direta
  tagline text null,
  presentation text null,
  proposals text null,
  video_url text null check (video_url is null or video_url ~ '^https://(www\.)?youtube\.com/|^https://youtu\.be/'),
  active boolean not null default true,
  display_order int not null default 0,
  created_at, updated_at
)

candidate_positions (
  id uuid pk,
  candidate_id uuid not null references candidates(id) on delete cascade,
  position_id uuid not null references positions(id) on delete restrict,
  created_at,
  unique (candidate_id, position_id)
)
-- Trigger BEFORE INSERT: impede um 3º registro para o mesmo candidate_id
-- (regra "até 2 cargos"), retornando erro explícito.
```

### 4.2 Eleitores e sessão de votação

```sql
voters (
  id uuid pk,
  registration_number text not null unique,
  full_name text not null,
  normalized_name text not null,       -- calculado no insert/update via trigger
  active boolean not null default true,
  created_at, updated_at
)
create index voters_normalized_name_idx on voters (normalized_name);

vote_sessions (
  id uuid pk,
  election_id uuid not null references elections(id),
  voter_id uuid not null references voters(id),
  token_hash text not null unique,      -- sha256 do token opaco guardado no cookie
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null,         -- setado ao enviar voto ou invalidar
  ip_hash text null,
  user_agent_summary text null
)
create index vote_sessions_voter_election_idx on vote_sessions (voter_id, election_id);
```

### 4.3 Voto (modelagem individual por slot, seção 46)

```sql
ballots (
  id uuid pk,
  election_id uuid not null references elections(id),
  created_at timestamptz not null default now(),
  submitted_at timestamptz not null
)
-- NOTA: ballots NÃO tem voter_id. A ligação eleitor→voto só existe em
-- audit_vote_links (seção 10). Isso é uma decisão de arquitetura — D2 abaixo.

ballot_choices (
  id uuid pk,
  ballot_id uuid not null references ballots(id) on delete cascade,
  position_id uuid not null references positions(id),
  candidate_id uuid null references candidates(id),
  is_null_vote boolean not null default false,
  vote_slot int not null,               -- 1..votes_per_voter da posição, permite repetição no mesmo candidato
  created_at timestamptz not null default now(),
  constraint ballot_choices_null_or_candidate check (
    (is_null_vote = true and candidate_id is null) or
    (is_null_vote = false and candidate_id is not null)
  ),
  unique (ballot_id, position_id, vote_slot)
)
create index ballot_choices_position_candidate_idx on ballot_choices (position_id, candidate_id);
create index ballot_choices_ballot_idx on ballot_choices (ballot_id);
```

### 4.4 Camada de auditoria (isolada)

```sql
audit_vote_links (
  id uuid pk,
  election_id uuid not null references elections(id),
  voter_id uuid not null references voters(id),
  ballot_id uuid not null references ballots(id),
  created_at timestamptz not null default now(),
  unique (election_id, voter_id),   -- ⟵ restrição estrutural contra voto duplicado
  unique (ballot_id)
)
```
Esta é a **única tabela** que relaciona eleitor a voto. RLS nega tudo (seção 10). Nenhuma outra tabela guarda esse vínculo.

### 4.5 Resultados e desempates

```sql
result_snapshots (                     -- gerado pela apuração interna, nunca calculado "ao vivo" no público
  id uuid pk,
  election_id uuid not null references elections(id),
  position_id uuid not null references positions(id),
  candidate_id uuid null references candidates(id),  -- null = linha de total de nulos
  votes_count int not null check (votes_count >= 0),
  rank int null,
  elected boolean not null default false,
  seat_label text null,
  computed_at timestamptz not null default now()
)

position_dual_winner_decisions (        -- seção 53
  id uuid pk,
  election_id uuid not null references elections(id),
  candidate_id uuid not null references candidates(id),
  position_id_a uuid not null references positions(id),
  position_id_b uuid not null references positions(id),
  status text not null default 'pending' check (status in ('pending','resolved')),
  chosen_position_id uuid null references positions(id),
  resolved_at timestamptz null,
  created_at
)

seat_reassignments (                    -- histórico, seção 54
  id uuid pk,
  election_id uuid not null references elections(id),
  position_id uuid not null references positions(id),
  vacated_by_candidate_id uuid not null references candidates(id),
  promoted_candidate_id uuid not null references candidates(id),
  reason text not null,
  created_at
)

runoff_candidates (                     -- quais candidatos empatados participam do desempate
  runoff_election_id uuid not null references elections(id),
  candidate_id uuid not null references candidates(id),
  primary key (runoff_election_id, candidate_id)
)

result_publications (
  id uuid pk,
  election_id uuid not null references elections(id) unique,
  published_at timestamptz null,
  created_at
)
```

### 4.6 Administração e segurança

```sql
admin_sessions (
  id uuid pk, token_hash text unique not null,
  created_at, expires_at, ip_hash text null
)

admin_logs (
  id uuid pk,
  action text not null,
  actor text not null default 'admin_session',
  metadata jsonb not null default '{}',
  created_at
)

security_events (
  id uuid pk,
  type text not null,       -- INVALID_VOTER_VALIDATION, DUPLICATE_VOTE_ATTEMPT, ADMIN_LOGIN_FAILURE, ...
  severity text not null check (severity in ('info','warning','critical')),
  ip_hash text null,
  user_agent_summary text null,
  route text null,
  metadata jsonb not null default '{}',
  created_at
)
create index security_events_type_created_idx on security_events (type, created_at);

rate_limit_counters (                    -- backend de rate limiting persistido no Postgres
  id uuid pk,
  scope text not null,                   -- 'voter_validate', 'admin_login'
  key_hash text not null,                -- hash(ip) ou hash(matrícula) ou combinação
  window_start timestamptz not null,
  attempts int not null default 1,
  blocked_until timestamptz null,
  unique (scope, key_hash, window_start)
)

site_access_stats (                      -- contagem agregada, não tracking individual
  id uuid pk,
  path text not null,
  day date not null,
  views int not null default 1,
  unique (path, day)
)
```

## 8. Row Level Security (RLS)

Princípio: **deny by default** em todas as tabelas (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` sem nenhuma policy = acesso zero para `anon`/`authenticated`).

| Tabela | Leitura pública (anon) | Escrita pública |
|---|---|---|
| `elections`, `election_phases` | Apenas colunas não sensíveis via **view pública** (`public_election_status`) — não a tabela crua | Não |
| `positions` | Sim, onde `active = true` | Não |
| `candidates` / `candidate_positions` | Sim, onde `active = true` | Não |
| `voters` | **Não** | **Não** |
| `vote_sessions` | **Não** | **Não** (somente via função SECURITY DEFINER) |
| `ballots` / `ballot_choices` | **Não** | **Não** |
| `audit_vote_links` | **Não, nunca** | **Não, nunca** |
| `result_snapshots` | Sim, **somente** quando `result_publications.published_at is not null` para aquela `election_id` (via view `public_results`) | Não |
| `result_publications` | Só o campo `published_at is not null` (via view), não a tabela crua | Não |
| `admin_sessions`, `admin_logs`, `security_events`, `rate_limit_counters`, `site_access_stats` | **Não** | **Não** |

Todas as operações de escrita e as leituras de tabelas sensíveis passam pelo cliente `service_role` dentro de Server Actions/Route Handlers, que **ignora RLS por natureza** — por isso toda validação de regra de negócio deve ocorrer explicitamente no código server-side e, como segunda camada, dentro das funções SQL `SECURITY DEFINER` (defesa em profundidade, seção 81/86).

Para o percentual de participação (seção 47), uma função `get_participation_percentage(election_id)` (SECURITY DEFINER, `GRANT EXECUTE TO anon`) retorna só o número agregado — nunca expõe linhas de `voters`.

## 9. Arquitetura da Votação

1. **Validação** (`POST /api/vote/validate`): recebe `registration_number` + `full_name`. Normaliza o nome (seção 22) no servidor. Chama função SQL que: confere eleição ativa e em fase de votação (hora do servidor), busca eleitor por matrícula, compara `normalized_name`, confere `active`, confere inexistência de `audit_vote_links` para essa `(election_id, voter_id)`. Qualquer falha → mensagem genérica (seção 23) + registro em `security_events`. Sucesso → cria `vote_sessions` (token aleatório de 256 bits, hash salvo no banco) e seta cookie `HttpOnly; Secure; SameSite=Strict` com TTL curto.
2. **Distribuição** (`/votar/urna`): client components controlam o estado local da distribuição por etapa (sem chamadas ao servidor por clique); validação de "X de Y distribuídos" é só UX. Nada é persistido até a confirmação final.
3. **Revisão** (`/votar/revisao`): renderiza o estado local; "Alterar" volta para a etapa; nada enviado ainda.
4. **Envio** (`POST /api/vote/submit`): envia o payload completo (seis posições × escolhas). O servidor:
   - Lê o cookie, recalcula o hash, busca `vote_sessions` válida e não consumida.
   - Revalida com Zod (sem campos inesperados, inteiros ≥ 0, candidato pertence à posição e está ativo).
   - Chama `cast_ballot(election_id, session_token_hash, choices jsonb)` — uma função SQL que, dentro de uma transação:
     - `SELECT ... FOR UPDATE` na linha de `voters` (lock).
     - Revalida fase de votação pela hora do Postgres.
     - Revalida que a sessão não foi consumida e não expirou.
     - Revalida que não existe `audit_vote_links` para esse voter+election (proteção estrutural, seção 39).
     - Revalida soma por posição == `votes_per_voter` e candidatos válidos (nunca confia em total enviado, seção 86 — a soma é `count(*)` das linhas, não um campo enviado pelo cliente).
     - Insere `ballots`, `ballot_choices` (um registro por slot).
     - Insere `audit_vote_links`.
     - Marca `vote_sessions.consumed_at`.
     - Em caso de qualquer falha: `ROLLBACK` automático (exceção propagada).
   - Resposta de sucesso limpa o cookie de sessão e seta um *flag* de curta duração (outro cookie `HttpOnly`, de uso único) que autoriza a renderização de `/voto-confirmado` exatamente uma vez.

## 10. Arquitetura de Auditoria

- `audit_vote_links` é a única tabela com o vínculo eleitor→voto; RLS nega tudo, inclusive para `service_role` em queries normais da aplicação (a aplicação nunca faz `SELECT` nela fora da função `cast_ballot`/relatórios de auditoria).
- Nenhuma rota, Server Action ou componente admin comum lê essa tabela.
- Desenho para evolução futura (seção 44, não implementado agora): a tabela já nasce isolada o suficiente para, depois, exigir uma credencial adicional (ex.: segundo fator, papel Postgres dedicado `audit_role` com policy própria) e/ou criptografar `voter_id`/`ballot_id` com uma chave (`AUDIT_ENCRYPTION_KEY`) mantida só no servidor, nunca no navegador. ⚠️ **D3** (decisão pendente) — ver abaixo.

## 11. Fluxo Administrativo

- Sessão única por senha (seção 58–61): `POST /api/admin/login` compara a senha enviada com `ADMIN_PASSWORD_HASH` (bcrypt/argon2) via função do servidor; sucesso cria `admin_sessions` + cookie `HttpOnly/Secure/SameSite=Strict`; toda tentativa (sucesso/falha) grava em `security_events`/`admin_logs`.
- Rate limiting progressivo por IP+tentativas (tabela `rate_limit_counters`), nunca bloqueio permanente só por IP (seção 24/61).
- Middleware/`layout.tsx` de `/admin/(protected)` valida o cookie a cada requisição (sem cache).
- Toda ação sensível (CRUD candidato, alteração de cronograma, abrir/encerrar votação, apurar, publicar, registrar decisão de cargo duplo, criar desempate) grava uma linha em `admin_logs` com `actor = 'admin_session'` e `metadata` descrevendo o que mudou.
- Apuração (seção 49): `compute_results(election_id)` (SECURITY DEFINER) recalcula e substitui `result_snapshots` a partir de `ballot_choices` (nunca aceita números vindos do cliente — seção 86). Marca `elections.results_computed_at`. **Não publica nada.**
- Publicação (seção 50): `/admin/resultados` mostra preview interno dos `result_snapshots`; botão "Liberar resultados" com confirmação dupla chama `publish_results(election_id)`, que seta `result_publications.published_at`.
- Empate (seção 55): `compute_results` detecta empate que impede definição de vaga e marca a posição com status `tie_pending` (sem resolver sozinho); dashboard mostra isso como pendência. Admin cria desempate em `/admin/desempates` (seção 56–57), que gera uma nova linha em `elections` (`type='runoff'`, `parent_election_id`), `runoff_candidates`, e reaproveita todo o pipeline de votação/apuração.
- Cargo duplo (seção 53–54): dashboard lista `position_dual_winner_decisions` pendentes; admin registra a escolha; o sistema então grava `seat_reassignments` promovendo o próximo colocado na posição liberada — nunca resolve automaticamente.

## 12. Estratégia de Segurança

- Zod em toda fronteira de entrada (Server Actions e Route Handlers), nunca confiando em validação só do navegador.
- Headers de segurança (via `next.config` / middleware): CSP restritiva, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (ou `frame-ancestors 'none'`), `Referrer-Policy: strict-origin-when-cross-origin`, HSTS.
- CSP `frame-src` liberando **apenas** `https://www.youtube-nocookie.com` (preferível ao domínio padrão do YouTube, por privacidade) — nunca um wildcard (seção 77).
- Cookies de sessão de voto e de admin sempre `HttpOnly; Secure; SameSite=Strict`.
- Rate limiting em `/api/vote/validate` e `/api/admin/login` com janelas progressivas (tabela `rate_limit_counters`), nunca banimento permanente só por IP.
- `ip_hash` em vez de IP completo (HMAC-SHA256 com segredo do servidor), com retenção curta configurável (ex.: expurgo de `security_events` com mais de 90 dias via job/cron — ⚠️ **D4**).
- Erros: qualquer exceção inesperada vira mensagem genérica ao usuário ("Ocorreu um erro. Tente novamente.") e log técnico completo só no servidor (nunca SQL, nomes de tabela, stack trace no payload de resposta).
- Nenhuma chave `service_role` ou segredo em `NEXT_PUBLIC_*`.

## 13. Endpoints / Server Actions

| Rota | Método | Sensível | Observação |
|---|---|---|---|
| `/api/vote/validate` | POST | Sim | Rate-limited, mensagens genéricas |
| `/api/vote/submit` | POST | Sim | Transação atômica `cast_ballot` |
| `/api/admin/login` | POST | Sim | Rate-limited, hash de senha |
| `/api/admin/logout` | POST | Sim | Invalida `admin_sessions` |
| `/api/admin/candidates` (+`/[id]`) | GET/POST/PATCH | Sim | CRUD + upload de foto |
| `/api/uploads/candidate-photo` | POST | Sim | Valida extensão/MIME/tamanho, nome seguro |
| `/api/admin/schedule` | PATCH | Sim | Atualiza `election_phases` |
| `/api/admin/election/open` \| `/close` \| `/compute-results` \| `/publish-results` | POST | Sim | Confirmação obrigatória no cliente, idempotentes no servidor |
| `/api/admin/runoffs` | POST | Sim | Cria desempate |
| `/api/admin/dual-winner-decisions/[id]` | PATCH | Sim | Registra escolha de cargo |
| Leituras públicas (status, cargos, candidatos, participação, resultados publicados) | — | Não | Server Components lendo via `anon` + views/RPCs acima |

## 14. Componentes

Conforme lista da seção 91 do prompt mestre — já refletida na árvore de `components/` na seção 2 deste documento. Nenhum desvio relevante; agrupei por domínio (`election`, `positions`, `candidates`, `vote`, `admin`, `feedback`) em vez de uma pasta só, para manter o projeto navegável à medida que cresce.

## 15. Estratégia de Testes

- **Unitários**: normalização de nome (acentos, maiúsculas, espaços), cálculo de status/fase a partir de datas, schemas Zod (payloads válidos/adulterados), cálculo de classificação/apuração a partir de `ballot_choices` sintéticos.
- **Integração** (Postgres local do Supabase CLI): todas as combinações da seção 93 (somas por cargo, repetição no mesmo candidato, nulos parciais/totais, soma incorreta, candidato inativo/de outro cargo, payload adulterado) chamando `cast_ballot` diretamente.
- **Concorrência** (seção 94): duas chamadas simultâneas de `cast_ballot` para o mesmo eleitor via `Promise.all`/conexões paralelas — exatamente uma deve committar, a outra deve falhar por violação de `unique(election_id, voter_id)` ou pelo lock.
- **Temporais** (seção 95): `cast_ballot` chamada com o relógio do Postgres mockado (ou fases com datas controladas) antes/durante/depois da votação; sessão criada antes do encerramento e enviada depois.
- **Admin** (seção 96): senha correta/incorreta, brute force/rate limit, sessão expirada, acesso a rota protegida sem cookie, candidato com 1/2/3 cargos (o terceiro deve falhar).
- **Resultado** (seção 97): não publicado vs publicado, soma correta de votos repetidos, nulos separados, empate, cargo duplo com promoção do próximo colocado, desempate.
- **E2E** (Playwright): fluxo completo do aluno (seção 99) e do administrador (seção 100) ponta a ponta contra um ambiente de staging com Supabase local.

---

## Decisões pendentes (preciso da sua confirmação antes de implementar)

Estas não são regras eleitorais da especificação — são escolhas de engenharia necessárias para implementar o que foi pedido. Vou seguir com as opções recomendadas (primeira de cada lista) se você não quiser entrar em detalhe agora, mas prefiro confirmar antes de gerar as migrations.

- **D1 — Horários de fase não configurados.** Enquanto o admin não configurar `start_time`/`end_time` de uma fase (ex.: votação), o sistema deve: (a) **recomendado** nunca transicionar automaticamente para essa fase (trava o status em "Aguardando votação" indefinidamente até configurar) ou (b) assumir um horário padrão (ex.: 00:00–23:59) só até o admin ajustar?
- **D2 — `ballots` sem `voter_id`.** Confirmar que a separação total (voto anônimo por padrão; vínculo só em `audit_vote_links`, tabela isolada e sem leitura em nenhuma rota/admin comum) é o design desejado — é a leitura mais forte da seção 42–44.
- **D3 — Criptografia de auditoria agora.** A seção 44 pede "projetar para permitir futuramente" — não implementar agora. Confirmo que por ora basta isolamento estrutural (tabela + RLS deny-all, sem rota alguma) e que `AUDIT_ENCRYPTION_KEY`/papel de auditoria adicional ficam documentados como evolução futura, não implementados nesta fase?
- **D4 — Retenção de `security_events`/`ip_hash`.** Proponho reter por 90 dias com expurgo manual (sem cron automático nesta fase, já que não há infraestrutura de jobs agendados definida). Período e mecanismo ok?
- **D5 — Rate limiting sem Redis.** Proponho implementar via tabela `rate_limit_counters` no próprio Postgres (simples, sem dependência externa) em vez de um serviço externo (Upstash/Redis). Isso é suficiente para o volume de uma eleição de turma, mas se vocês já têm Upstash disponível no projeto, posso usar — me avise.
- **D6 — Hospedagem/deploy.** Vou assumir Vercel (Next.js) + Supabase Cloud como ambiente alvo, documentando variáveis de ambiente e passos de deploy no README. Confirma, ou já existe um projeto Supabase específico (URL/chaves) que devo usar?

Assim que confirmar (ou aprovar os defaults recomendados), começo a implementação pelas migrations SQL + schema, seguido da estrutura de páginas e componentes.
