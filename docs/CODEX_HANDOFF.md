
---

# CODEX_HANDOFF.md

> Documento de transferência técnica — Eleição da Comissão de Formatura, Turma 36 (Medicina UniEVANGÉLICA).
> Gerado a partir da inspeção do repositório em `c908d4b`. **O código é a fonte da verdade**; este documento é um retrato datado.

---

## LEIA ISTO ANTES DE ALTERAR O PROJETO

As 10 coisas que mais provavelmente causarão dano se ignoradas:

1. **Esta é uma eleição real, com uma votação já realizada em ambiente de teste.** Regressão aqui não é bug de UI — é voto errado ou resultado vazado.

2. **Nunca edite uma migration já aplicada.** `supabase/migrations/0001` a `0015` podem estar em bancos reais. Toda mudança de banco = **migration nova** com o próximo número livre (hoje: `0016`).

3. **A regra crítica vive no PostgreSQL, não no TypeScript.** `cast_ballot`, `validate_voter`, `compute_results`, `publish_results` revalidam tudo. O frontend nunca é fonte de verdade — se você "otimizar" movendo validação para o cliente, quebra o sistema.

4. **`service_role` sofre GRANT.** Ele tem `BYPASSRLS` (ignora *policies*), mas continua sujeito à ACL do Postgres. Isso já quebrou produção **duas vezes** (migrations `0010` e `0011`). Toda função nova precisa de `REVOKE` + `GRANT` explícito **e teste de ACL**.

5. **O status eleitoral nunca é cacheado.** `compute_election_status` depende de `now()` do Postgres e é o que autoriza a urna. Cachear isso libera ou nega voto na hora errada.

6. **O relógio do navegador nunca decide nada.** O countdown é decorativo; a autorização é sempre server-side.

7. **`'unsafe-eval'` só existe em development** (`proxy.ts`). Produção é estrita e deve permanecer. Há teste travando os dois lados (`tests/unit/csp.test.ts`).

8. **Server Components não podem modificar cookies** no Next 16. Isso já quebrou a tela pós-voto. Só Server Action ou Route Handler escreve/apaga cookie.

9. **Antes de concluir qualquer tarefa**: `npm test`, `npm run test:integration`, `npm run lint`, `npx tsc --noEmit`, `npm run build`. Todos verdes, sem exceção.

10. **Se uma regra eleitoral não estiver definida no código, nos testes ou no `TECHNICAL_DESIGN.md` — PERGUNTE.** Não invente. Várias regras deste sistema foram decididas por pergunta explícita ao responsável.

---

## 1. Identificação do estado exato

| Item | Valor |
|---|---|
| Repositório | `https://github.com/vcsil/eleicaoRepresent` |
| Branch | `claude/modest-sagan-pq6gq1` |
| HEAD | `c908d4b530dfa1f029619becf1f8ab3b81392690` |
| Último commit | `feat(runoff): make the public flow able to vote in a tie-break election` |
| Working tree | limpo |
| PR aberta | #4 (desempate completo, já foi feito merge na main) |

**Versões** (confirmadas em `package.json` + `package-lock.json`, `lockfileVersion: 3`):

| Pacote | Versão resolvida |
|---|---|
| next | 16.3.5 (App Router, Turbopack) |
| react / react-dom | 19.2.8 |
| typescript | 5.9.3 |
| @supabase/supabase-js | 2.116.0 |
| zod | 4.6.2 |
| tailwindcss | 4.3.3 |
| vitest | 5.0.0 |
| pg (dev) | 8.23.0 |
| bcryptjs | 3.0.3 |

- **Node**: v22.22.2 no ambiente atual. **Não há `engines`, `.nvmrc` nem `.node-version`** — a versão não está fixada no repositório.
- **Package manager**: npm (`package-lock.json`).
- **Deploy**: Vercel (frontend) + Supabase (Postgres + Storage).
- **Região**: `gru1` (São Paulo) — mencionada em `docs/PERFORMANCE_V2.md` como premissa das medições de latência; **não há arquivo de configuração da Vercel no repositório** confirmando isso.
- **Serviços externos**: Supabase (banco, auth do service_role, Storage para fotos), YouTube nocookie (embed de vídeos de candidatos, liberado em `frame-src`).

---

## 2. Resumo funcional

Aplicação que substitui um Google Forms para eleger a Comissão de Formatura de uma turma de Medicina. Ela concentra informação (cronograma, cargos, candidatos) **e** conduz a votação com garantias reais de integridade.

**Modelo de voto: distribuição.** Cada cargo tem N vagas e concede N votos ao eleitor, que deve distribuí-los integralmente. **Repetir votos no mesmo candidato é permitido** (concentrar 2 votos numa pessoa em Tesouraria, por exemplo). "Nulo" é uma opção explícita — e nunca um `NULL` de SQL, é `is_null_vote = true`.

Pelo seed oficial: Presidente 1, Vice 1, Tesouraria 2, Secretaria 2, Marketing 3, Eventos 4 = **13 vagas e 13 votos por eleitor**.

**Tipos de usuário:**
- **Eleitor** — anônimo no site, identificado só no momento do voto por matrícula + nome completo. Não tem conta.
- **Administrador** — senha única compartilhada (não há contas individuais; decisão explícita, ver §27).

**Ciclo completo do negócio:**

```
edital → candidaturas → divulgação → apresentação → VOTAÇÃO
  → encerramento (automático por data OU manual)
  → apuração interna (compute_results)
  → pendências? (empate na linha de corte / candidato eleito em 2 cargos)
       ├─ sim → desempate ou decisão administrativa → resolve
       └─ não
  → publicação (publish_results)
  → /resultados público
```

A fase corrente é **calculada**, não armazenada: `compute_election_status()` deriva o status das datas em `election_phases` comparadas com `now()` do Postgres, mais flags de encerramento/apuração/publicação.

**Páginas públicas**: `/` (status ao vivo, countdown, timeline, participação), `/cargos`, `/candidatos`, `/votar` → `/votar/urna` → `/votar/revisao` → `/voto-confirmado`, `/resultados`.

**Páginas administrativas** (`/admin` + `/admin/(protected)/*`): dashboard, candidatos (CRUD + foto), cronograma, votação (encerrar/apurar), resultados (publicar), desempates, segurança (eventos).

**Operações sensíveis**: registrar voto, encerrar votação, apurar, publicar, criar desempate, resolver cargo duplo, invalidar cache. Todas passam por Server Action + RPC `SECURITY DEFINER` e gravam em `admin_logs` ou `security_events`.

---

## 3. Arquitetura

**O que roda no navegador** — apenas apresentação e rascunho local:
- wizard da urna (`components/vote/BallotWizard.tsx`), com rascunho em `sessionStorage`
- countdown, badge de status e barra de participação (`components/election/LiveElectionState.tsx`), com polling de 30s
- formulários administrativos

**O que roda no servidor Node (Vercel)**:
- Server Components renderizando todas as páginas (**as 19 rotas são `force-dynamic`**)
- Server Actions para toda mutação
- um único Route Handler: `app/api/public/live-state/route.ts`
- `proxy.ts` (middleware) injetando CSP com nonce por requisição
- dois clientes Supabase: `createAnonClient()` (sujeito a RLS, leituras públicas) e `createServiceClient()` (ignora RLS, só em Server Actions/Route Handlers)

**O que roda dentro do PostgreSQL** — é aqui que mora a regra:
- cálculo de status e janelas de fase
- validação do eleitor e emissão de sessão
- registro atômico do voto com todas as validações de distribuição
- apuração, detecção de empate, publicação
- criação e resolução de desempate
- rate limiting

**Divisão de responsabilidade, em uma frase:** o TypeScript orquestra e apresenta; o PostgreSQL decide e garante.

---

## 4. Estrutura do repositório

```
app/
  (public)/          páginas públicas + fluxo de voto
  admin/             login em app/admin/page.tsx
  admin/(protected)/ layout com guarda de sessão; todas as telas administrativas
  api/public/live-state/route.ts    único Route Handler
components/
  vote/              urna, revisão, contadores, validação
  election/          countdown, badge, timeline, estado ao vivo
  admin/             formulários e painéis
  ui/ feedback/ layout/   primitivos
lib/
  election/          status, fases, candidatos, cargos, resultados, sessão de voto,
                     eleição ativa, opções da urna, estado ao vivo
  admin/             sessão admin, métricas, runoffs, logs, upload de foto
  security/          hashing (HMAC), IP, rate limit, eventos
  supabase/          server.ts (anon) e service.ts (service_role)
  cache/tags.ts      fonte única das tags de cache
  validation/schemas.ts   schemas Zod de toda entrada
  vote/draft.ts      forma do rascunho + chave por sessão
proxy.ts             middleware: CSP, nonce, headers de segurança
supabase/migrations/ 0001–0015
supabase/seed.sql    eleição, 6 cargos, cronograma
tests/unit/ tests/integration/
docs/                TECHNICAL_DESIGN.md, PERFORMANCE_V2.md, DEPLOY_V2.md
```

**Módulos que você vai tocar com mais frequência e que exigem cuidado:**

| Arquivo | Responsabilidade | Por que é delicado |
|---|---|---|
| `lib/election/status.ts` | eleição principal (cacheada) + status (não cacheado) | separação cache/não-cache é intencional |
| `lib/election/active-election.ts` | resolve qual eleição está aberta | decide se existe urna |
| `lib/election/vote-session.ts` | cookies de voto + chave do rascunho + eleição da sessão | três bugs históricos moram aqui |
| `lib/election/ballot-options.ts` | cédula por eleição (geral vs desempate) | vazamento de candidatos se errar |
| `lib/cache/tags.ts` | tags de cache | fonte única; divergir daqui = dado velho eterno |
| `lib/security/rate-limit.ts` | tetos por dimensão | teto errado barra eleitores legítimos |

---

## 5. Modelo de dados

22 tabelas com RLS habilitada. As críticas:

**`elections`** — normalmente uma linha `type='general'`. Desempates são linhas `type='runoff'` com `parent_election_id`. Flags que dirigem o ciclo: `voting_closed_manually_at`, `results_computed_at`, `results_published_at`. CHECK `runoff_requires_parent` (relaxado na `0013`) exige `parent_election_id` em todo runoff.

**`election_phases`** — `unique (election_id, phase_key)`. Datas + horários; `time_configured` distingue horário padrão de configurado.

**`voters`** — `registration_number` unique, `normalized_name` gerado por trigger (`normalize_name`, usa `unaccent`). `has_voted`/`voted_at` são **informativos**: escritos por `cast_ballot`, **nunca usados para bloquear**. A unicidade real é outra (ver abaixo).

**`vote_sessions`** — `token_hash` unique (SHA-256; o token nunca é gravado em claro), `expires_at`, `consumed_at`. Escopada por `election_id` — é isso que impede uma sessão da geral votar num desempate.

**`ballots` / `ballot_choices`** — a cédula e uma linha **por voto individual** (repetição vira múltiplas linhas). `unique (ballot_id, position_id, vote_slot)`.

**`audit_vote_links`** — **a tabela que garante a regra estruturalmente**: `unique (election_id, voter_id)` + `unique (ballot_id)`. É a constraint que faz "um voto por eleitor **por eleição**" — e é exatamente por ser escopada por eleição que o mesmo eleitor pode votar no desempate. Liga eleitor ↔ cédula, então é a tabela mais sensível do sistema.

**`result_snapshots`** — resultado materializado pela apuração, nunca calculado ao vivo. `elected`, `tie_break_needed`, `rank`, `seat_label`, mais nome/foto/cargo **denormalizados** (migration `0008`) porque a policy pública de `candidates`/`positions` só libera `active = true` e o histórico precisa sobreviver a uma desativação. Linha com `candidate_id IS NULL` = total de nulos.

**`runoff_positions`** (migration `0013`) — cargos em disputa num desempate, com `vacancies_in_dispute` e `votes_per_voter` **derivados**, `parent_election_id` denormalizado e `resolved_at`. Carrega o índice parcial que impede duplicação:

```sql
create unique index runoff_positions_one_unresolved_per_parent_position
  on runoff_positions (parent_election_id, position_id) where resolved_at is null;
```

**`runoff_candidates`** — PK `(runoff_election_id, position_id, candidate_id)` desde a `0013`.

**`runoff_resolutions`** (`0013`) — registro auditável de cada vaga resolvida por desempate, com `votes_in_runoff`. `unique (parent_election_id, position_id, candidate_id)` dá idempotência.

**`rate_limit_counters`** — `unique (scope, key_hash, window_start)`, janelas fixas alinhadas ao epoch.

---

## 6. Migrations

**Última: `0015`. Próximo número livre: `0016`.**

| # | Arquivo | Finalidade |
|---|---|---|
| 0001 | `extensions` | pgcrypto + unaccent no schema `extensions` |
| 0002 | `schema` | 20 tabelas, constraints, índices, triggers |
| 0003 | `status_and_helpers` | `compute_election_status`, `election_phase_bounds`, rate limiting |
| 0004 | `voting_functions` | `validate_voter`, `cast_ballot` |
| 0005 | `results_functions` | `compute_results`, `publish_results`, participação, cargo duplo, runoff v1 |
| 0006 | `rls` | RLS deny-by-default + policies públicas |
| 0007 | `storage` | bucket `candidate-photos` |
| 0008 | `result_snapshot_denormalization` | nome/foto/cargo em `result_snapshots` |
| 0009 | `analytics` | `increment_page_view` |
| **0010** | `fix_service_role_grants` | **correção**: EXECUTE em 8 funções + `compute_election_status` vira SECURITY DEFINER |
| **0011** | `grant_service_role_tables` | **correção**: `grant all on all tables to service_role` |
| 0012 | `dashboard_and_live_state` | `get_admin_dashboard_metrics`, `get_live_election_state` |
| 0013 | `runoff_multi_position_schema` | desempate multi-cargo, resoluções, anti-duplicação |
| 0014 | `runoff_functions` | reescreve `create_runoff_election`; `resolve_parent_ties_from_runoff`; `publish_results`, `compute_results`, `cast_ballot` cientes de desempate; `get_current_voting_election` |
| 0015 | `live_state_follows_active_election` | estado ao vivo segue a votação aberta + policy pública de `runoff_resolutions` |

**`0010` e `0011` existem porque migrations anteriores foram corrigidas por acréscimo, não por reescrita.** Mantenha esse padrão.

⚠️ **`0013`–`0015` ainda não foram aplicadas em nenhum banco real** — estão só na PR #4 e nos bancos locais de teste.

⚠️ **`0014` substitui `compute_results`, `cast_ballot` e `publish_results`** — o caminho validado na primeira simulação. É a migration de maior risco do repositório.

---

## 7. RPCs / funções Postgres

Todas as funções abaixo são `SECURITY DEFINER` com `SET search_path = public, extensions, pg_temp`, salvo indicação.

| Função | Chamador | Permissão | Papel |
|---|---|---|---|
| `compute_election_status(uuid)` | anon + service | `anon, authenticated` | **Fonte da verdade do status.** Deriva de `now()` e das fases. Nunca cacheada. |
| `election_phase_bounds(uuid, text)` | interno | — | janela efetiva de uma fase (não é SECURITY DEFINER) |
| `check_and_increment_rate_limit(text,text,int,int,int)` | `lib/security/rate-limit.ts` | `service_role` | janela fixa + bloqueio escalonado |
| `validate_voter(uuid,text,text,text,text,int)` | `app/(public)/votar/actions.ts` | `service_role` | valida matrícula+nome normalizado, checa `audit_vote_links` por eleição, invalida sessões anteriores, emite token |
| `cast_ballot(text, jsonb)` | `app/(public)/votar/revisao/actions.ts` | `service_role` | **A função mais crítica.** Lock da sessão e do eleitor, revalida status, exige todos os cargos, soma exata por cargo, proíbe chave duplicada, valida candidato por cargo, insere cédula + escolhas + link de auditoria, consome a sessão. Tudo numa transação. |
| `compute_results(uuid)` | `/admin/votacao` | `service_role` | apura, marca `elected`/`tie_break_needed`, rótulos de assento, detecta cargo duplo. Idempotente (apaga e recria snapshots). |
| `publish_results(uuid)` | `/admin/resultados` | `service_role` | recusa com `TIE_PENDING`, `DUAL_WINNER_PENDING`, `RUNOFF_PENDING`. **Se a eleição é um runoff, resolve o pai na mesma transação.** |
| `get_participation_percentage(uuid)` | público | `anon, authenticated` | só o agregado, nunca linhas |
| `create_runoff_election(uuid, uuid[], text, date, date, time, time)` | `/admin/desempates` | `service_role` | **Deriva candidatos e vagas do banco.** Não aceita lista do cliente. |
| `resolve_parent_ties_from_runoff(uuid)` | `publish_results` | `service_role` | marca vencedores no pai **sem tocar em `votes_count`**, grava `runoff_resolutions` |
| `get_current_voting_election()` | `/votar` (anon) | `anon, authenticated, service_role` | **Falha alto** (`AMBIGUOUS_ACTIVE_ELECTION`) em vez de escolher |
| `get_live_election_state(uuid)` | home + Route Handler | `anon, authenticated, service_role` | status + participação + hora + id da eleição ativa. Nada além. |
| `get_admin_dashboard_metrics(uuid)` | `/admin/dashboard` | **só `service_role`** | contagens de eventos de segurança — jamais alcançável pela chave pública |
| `resolve_dual_winner_decision(uuid, uuid)` | `/admin/desempates` | `service_role` | libera a vaga e promove o próximo, com histórico em `seat_reassignments` |
| `increment_page_view(text)` | `after()` | `service_role` | contagem agregada, sem rastreamento individual |

---

## 8. RLS, ACL e segurança

**RLS deny-by-default.** 22 tabelas com RLS ligada; apenas 9 policies, todas de leitura pública e restritas:

- `positions`, `candidates`, `candidate_positions`, `election_phases`, `elections`, `runoff_candidates` → só conteúdo ativo/público
- `result_snapshots` → **só de eleição com `results_published_at is not null`** — é o que impede resultado parcial de vazar
- `runoff_resolutions` → só quando a **eleição principal** foi publicada
- `storage.objects` → leitura das fotos

Nenhuma policy de escrita para `anon`/`authenticated`. Toda escrita passa por `service_role` ou função `SECURITY DEFINER`.

**Papéis**: `anon` (chave pública, leituras públicas), `authenticated` (não usado — não há contas de usuário), `service_role` (backend confiável, nunca no navegador).

### Os dois bugs de permissão que já quebraram produção

**Reincidir neles é o erro mais fácil de cometer neste projeto.**

1. **`REVOKE ALL ... FROM PUBLIC` remove o acesso que `service_role` herdava de `PUBLIC`.** Funções recebem `EXECUTE` a `PUBLIC` por padrão na criação; ao revogar por segurança, revoga-se também do `service_role`. Sintoma: `permission denied for function increment_page_view`. Corrigido na `0010`.

2. **Tabelas não recebem privilégio a `PUBLIC` por padrão**, e nenhuma migration havia concedido nada a `service_role`. `BYPASSRLS` ignora *policies*, não ACL. Sintoma: `permission denied for table admin_sessions` no login. Corrigido na `0011`.

**Regra derivada:** toda função nova precisa de `REVOKE ALL ... FROM public, anon, authenticated` + `GRANT` explícito ao papel certo, **com teste de ACL** (`tests/integration/function-grants.test.ts`).

**Outras camadas:**
- Cookies `HttpOnly` + `Secure` + `SameSite=Strict`. `Secure` funciona em `http://localhost` porque navegadores tratam localhost como origem confiável.
- IPs **nunca** armazenados em claro — HMAC-SHA256 com `APP_SECRET_KEY` (`lib/security/hashing.ts`). Tokens de sessão gravados como SHA-256.
- Rate limiting em duas dimensões independentes: **IP 100/5min** (rede compartilhada da faculdade) e **matrícula 10/5min** (o anti-força-bruta real).
- **Anti-enumeração**: `validate_voter` devolve `invalid` genérico para matrícula inexistente, nome errado ou eleitor inativo — não distingue os casos.
- CSP com nonce por requisição + `strict-dynamic` (§15).
- `security_events` registra `INVALID_VOTER_VALIDATION`, `DUPLICATE_VOTE_ATTEMPT`, `RATE_LIMIT_TRIGGERED`, `INVALID_VOTE_PAYLOAD`, `ADMIN_LOGIN_*`.

**Nunca pode chegar ao navegador**: `SUPABASE_SERVICE_ROLE_KEY`, `APP_SECRET_KEY`, `ADMIN_PASSWORD_HASH`, qualquer linha de `audit_vote_links`, `vote_sessions`, `voters`, `security_events`, `admin_*`, e `result_snapshots` de eleição não publicada.

---

## 9. NÃO QUEBRAR — invariantes

1. **Um voto por eleitor por eleição**, garantido por `unique (election_id, voter_id)` em `audit_vote_links` — não por lógica de aplicação, não por `voters.has_voted`.
2. **`voters.has_voted` é informativo.** Se você começar a usá-lo para bloquear, quebra o desempate.
3. **Voto é atômico.** `cast_ballot` faz tudo numa transação plpgsql. Não fatie em chamadas sequenciais do Node.
4. **A distribuição é revalidada no Postgres.** Soma exata por cargo, todos os cargos presentes, candidato pertencente ao cargo, sem chave duplicada. O cliente não é confiável.
5. **"Nulo" nunca é candidato** — é `is_null_vote = true`, `candidate_id` nulo.
6. **Status nunca cacheado**, nunca calculado no cliente.
7. **Relógio do navegador não autoriza nada.**
8. **Resultado só depois de publicado** — garantido pela policy RLS, não por `if` na página.
9. **`publish_results` não publica com pendência aberta.**
10. **Votos da eleição original nunca são sobrescritos** pelo desempate. Registros distintos.
11. **Desempate nunca resolve empate automaticamente.** Sem sorteio, ordem alfabética, matrícula ou horário.
12. **Candidatos e vagas do desempate são derivados do banco**, nunca vindos do formulário.
13. **Cache não decide autorização.**
14. **Sessão e voto nunca cacheados.**
15. **`service_role` jamais no navegador.**
16. **Rascunho da urna é isolado por sessão** — dispositivo compartilhado.
17. **CSP de produção sem `unsafe-eval`.**
18. **Cookies só são modificados em Server Action ou Route Handler.**

---

## 10. Cache e performance

Data Cache do Next com `unstable_cache` + `revalidate: false` — **os dados nunca expiram por tempo**, só por invalidação explícita.

**Decisão deliberada de NÃO ligar `cacheComponents: true`**: é flag top-level que muda o modelo de renderização das 19 rotas, e o app tem CSP com nonce por requisição, sessões por cookie e uma eleição real. O ganho seria de API, não de latência.

**Premissa verificada na fonte do Next 16.3.5**: `dynamic = "force-dynamic"` **não** desativa a leitura do `unstable_cache` (só `force-no-store`, on-demand revalidate e draft mode). É isso que permite páginas dinâmicas com dados cacheados.

**Tags** (`lib/cache/tags.ts` — fonte única): `public-election`, `election-phases`, `positions`, `candidates`, `ballot-options`, `published-results`.

**O que é cacheado**: `fetchMainElection`, `fetchElectionPhases`, `fetchActivePositions`, `fetchActiveCandidates`, `fetchPublishedResults`, `fetchRunoffRounds`.

**Matriz de invalidação:**

| Ação | Arquivo | Tags |
|---|---|---|
| CRUD candidato | `admin/(protected)/candidatos/actions.ts` | `candidates`, `ballot-options` |
| alterar cronograma | `cronograma/actions.ts` | `election-phases`, `public-election` |
| encerrar/apurar | `votacao/actions.ts` | `public-election` |
| publicar resultados | `resultados/actions.ts` | `published-results`, `public-election` |
| resolver cargo duplo | `desempates/actions.ts` | `published-results` |
| criar desempate | `desempates/actions.ts` | `public-election`, `election-phases`, `ballot-options` |
| botão manual | `dashboard/actions.ts` | **todas** (itera `CACHE_TAGS`) |

Usa-se `updateTag`, não `revalidateTag`: em 16.3.5 o segundo emite deprecation warning com argumento único e tem semântica eventual; `updateTag` expira na hora e dá read-your-own-writes.

**Nunca cacheado**: status, participação, sessões, votos, leitura administrativa sensível, opções da urna de desempate.

**Limitação conhecida**: alteração feita **direto no banco** não invalida nada. Mitigação: botão "Atualizar dados do site" em `/admin/dashboard`.

**Polling** (`components/election/LiveElectionState.tsx`): 30s, **só durante a votação**, pausado com aba em background (Page Visibility), atualização imediata ao voltar o foco, último valor preservado em falha de rede. É um **provider de contexto** — um único fetch alimenta badge, participação e countdown, que ficam em seções distantes da página.

**Analytics fora do caminho crítico**: `trackPageView` roda em `after()` (`lib/analytics/track.ts`).

**Resultados medidos** (`docs/PERFORMANCE_V2.md`): home durante votação 5 → 1 requisição bloqueante; `/cargos` e `/candidatos` → 0; `/admin/dashboard` 9 → 1.

---

## 11. Sessões e cookies

| Cookie | Função | Duração | Flags | Criado | Lido | Apagado |
|---|---|---|---|---|---|---|
| `admin_session` | sessão administrativa | 2h | HttpOnly, Secure, Strict, `/` | `app/admin/actions.ts` | `admin/(protected)/layout.tsx` | logout |
| `vote_session` | autoriza a urna | 20min (= TTL do banco) | HttpOnly, Secure, Strict, `/` | `votar/actions.ts` após `validate_voter` | urna, revisão, `cast_ballot` | após voto e em erros terminais |
| `vote_confirmed` | libera `/voto-confirmado` | 5min (`maxAge`) | HttpOnly, Secure, Strict, `/` | `votar/revisao/actions.ts` | `voto-confirmado/page.tsx` (**só leitura**) | ao validar novo eleitor |

**Regra do Next 16 que já quebrou o sistema:** Server Components **não podem** modificar cookies. `consumeVoteConfirmedCookie` apagava o cookie ao lê-lo, e o único chamador era a página `/voto-confirmado` — um Server Component. Pior: o `delete` só rodava quando o cookie existia, ou seja, **exatamente no caminho de sucesso do voto**. Hoje a função se chama `hasVoteConfirmedCookie` e apenas lê; a limpeza migrou para `validateVoterAction` (Server Action). Protegido por `tests/unit/vote-session-cookies.test.ts`, cujo mock **falha se `set` ou `delete` forem chamados**.

---

## 12. Fluxos críticos

### Voto (eleição geral ou desempate — o mesmo fluxo)

```
/votar
→ getCurrentVotingElection()  [RPC; se null → "votação não disponível"]
→ formulário: matrícula + nome
→ validateVoterAction
   ├─ Zod
   ├─ rate limit IP + matrícula EM PARALELO (ambos sempre avaliados)
   ├─ validate_voter(eleição ATIVA) → invalid | already_voted | voting_not_open | ok
   ├─ limpa vote_confirmed (dispositivo compartilhado)
   ├─ grava cookie vote_session
   └─ redirect /votar/urna
→ /votar/urna
   ├─ getVoteSessionElection(token)  [eleição DA SESSÃO, não a ativa]
   ├─ getBallotOptions(sessão)       [geral: tudo | runoff: só o empate]
   ├─ draftKey = HMAC(token)[0..16]  [isolamento por sessão]
   └─ prune de rascunhos de outras sessões
→ /votar/revisao → submitBallotAction
   ├─ Zod
   ├─ cast_ballot(token, payload)  [TUDO revalidado no Postgres]
   ├─ setVoteConfirmedCookie + clearVoteSessionCookie
   └─ router.push("/voto-confirmado")
```

Erros esperados: `SESSION_INVALID`, `SESSION_EXPIRED`, `VOTING_CLOSED`, `ALREADY_VOTED`, `INVALID_PAYLOAD`, `INVALID_CANDIDATE`, `INVALID_VOTE_SUM`.

### Apuração → publicação

```
encerrar votação (manual) → compute_results
→ marca elected / tie_break_needed / seat_label
→ detecta candidato eleito em 2 cargos
→ publish_results
   ├─ TIE_PENDING? → bloqueia
   ├─ DUAL_WINNER_PENDING? → bloqueia
   ├─ RUNOFF_PENDING? → bloqueia
   └─ publica → /resultados fica visível pela RLS
```

### Desempate (ciclo completo)

```
empate detectado (tie_break_needed no pai)
→ /admin/desempates: escolhe cargos + cronograma
→ create_runoff_election  [deriva candidatos e vagas; índice barra duplicata]
→ get_current_voting_election passa a apontar para o desempate
→ home mostra "Votação de desempate em andamento"
→ eleitores (inclusive quem já votou) votam
→ encerrar + compute_results(runoff)
→ publish_results(runoff)
   └─ resolve_parent_ties_from_runoff NA MESMA TRANSAÇÃO
      ├─ N mais votados → elected=true no PAI
      ├─ grupo empatado → tie_break_needed=false
      ├─ seat_label continua a numeração
      ├─ runoff_resolutions (auditável)
      └─ votes_count do pai INTOCADOS
→ publish_results(pai) agora passa
```

Se o desempate empatar: `TIE_PENDING`, pendência permanece, admin cria rodada filha.

---

## 13. Bugs já encontrados e corrigidos

Priorizados por probabilidade de reintrodução.

| # | Sintoma | Causa raiz | Correção | Teste de regressão |
|---|---|---|---|---|
| 1 | `permission denied for function` | `REVOKE ALL FROM PUBLIC` tirou o acesso herdado do `service_role` | `0010` | `tests/integration/function-grants.test.ts` |
| 2 | `permission denied for table admin_sessions` | tabelas não dão privilégio a `PUBLIC`; nada concedido a `service_role` | `0011` | idem |
| 3 | **`TIE_PENDING` eterno** | nada resolvia o empate do pai; só uma fixture de teste zerava `tie_break_needed` | `0013`/`0014` + resolução transacional | `desempate-runoff.test.ts` (4 testes) |
| 4 | **Desempate não votável** | `/votar` resolvia sempre `type='general'` | `get_current_voting_election` | `voter-validation-flow.test.ts` |
| 5 | **Rascunho vazava entre eleitores** | chave fixa em `sessionStorage`; B via e podia enviar a cédula de A | chave por HMAC da sessão + prune | `ballot-draft-isolation.test.ts` |
| 6 | Tela pós-voto quebrada | Server Component apagando cookie | leitura pura + limpeza na action | `vote-session-cookies.test.ts` |
| 7 | Hydration mismatch | `Date.now()` durante o render do countdown | snapshot do servidor + offset | `countdown.test.ts` |
| 8 | Fast Refresh recarregando a página | CSP bloqueava o `eval` do Turbopack | `unsafe-eval` só em dev | `csp.test.ts` |
| 9 | Rate limit barrando a turma | IP e matrícula com o mesmo teto (8/5min) numa rede compartilhada | 100 / 10 | `voter-validation-flow.test.ts` |
| 10 | `candidate_name` nulo | `compute_results` reescrito sobre a `0005` em vez da `0008` | regenerado da `0008` | ciclo em `desempate-runoff.test.ts` |

**#10 é um alerta de método**: ao reescrever uma função, parta da **última** versão dela, não da migration que a criou.

---

## 14. Hydration / SSR / CSR

**Padrão obrigatório: nunca leia relógio nem API de navegador durante o render.**

O countdown quebrava a hidratação porque `getRemaining` chamava `Date.now()` no render: servidor e cliente calculavam com relógios diferentes e os segundos divergiam pelo tempo de rede + hidratação.

Solução atual (`lib/election/countdown.ts` + `components/election/Countdown.tsx`):
1. `getRemaining(targetIso, nowMs)` é **pura** — recebe o instante.
2. Primeiro render (servidor **e** hidratação) usa `serverNowMs`, vindo de `get_live_election_state`. Markup idêntico.
3. `useEffect` calcula `offset = serverNow - Date.now()` e passa a contar com `Date.now() + offset`. O cronômetro segue a hora do servidor mesmo com relógio desregulado, sem nenhuma requisição por segundo.

**O ESLint do React Compiler (`react-hooks/purity`) recusa `Date.now()` no render.** Não suprima — reestruture.

**`suppressHydrationWarning` não é usado em lugar nenhum. Mantenha assim.**

`sessionStorage` é lido via `useSyncExternalStore` com snapshot de servidor `null`. Efeito colateral conhecido: carregar `/votar/revisao` diretamente (F5 ou URL colada) redireciona para a urna. Benigno — o rascunho é preservado — e não ocorre no fluxo normal.

---

## 15. CSP

Montada em `proxy.ts`, com nonce novo (`crypto.randomUUID()`) por requisição.

```
default-src 'self'
script-src 'self' [dev: 'unsafe-eval'] 'nonce-<...>' 'strict-dynamic'
style-src 'self' 'unsafe-inline'
img-src 'self' data: https://<supabase>
font-src 'self' data:
connect-src 'self' https://<supabase> wss://<supabase>
frame-src https://www.youtube-nocookie.com
frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
upgrade-insecure-requests
```

**`'unsafe-eval'` só em `NODE_ENV === "development"`**, por necessidade funcional comprovada: o runtime do Turbopack aplica hot updates via `eval`. Sem a diretiva, toda edição de componente força recarga completa — na urna, isso perde a distribuição em andamento. Em produção o bundle não contém `eval` algum (varredura em 30 chunks), então a diretiva seria superfície de ataque sem contrapartida.

`connect-src 'self'` já cobre o fetch do polling — **a CSP não precisou de alteração** para o estado ao vivo. Headers extras: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `HSTS`, `Permissions-Policy`.

---

## 16. Testes

```bash
npm test               # unitários (sem dependências externas)
npm run test:integration   # integração (exige Postgres local)
npm run test:all       # ambos
```

**159 testes em 18 arquivos, todos passando** (confirmado nesta sessão).

⚠️ **Os testes de integração exigem Postgres rodando.** Se falharem em massa com `ECONNREFUSED 127.0.0.1:5432`, é o serviço parado, não regressão. `TEST_DATABASE_URL` (padrão `postgresql://postgres@localhost:5432/eleicao_test`) precisa apontar para um banco com as migrations aplicadas e `service_role` com `BYPASSRLS`.

| Tipo | Arquivo | Protege |
|---|---|---|
| **integração/banco** | `cast-ballot.test.ts` (14) | regras de distribuição, atomicidade, nulo, duplicidade |
| | `apuracao.test.ts` (5) | apuração, empate na linha de corte, nulos |
| | `desempate.test.ts` (3) | cargo duplo e promoção |
| | `desempate-runoff.test.ts` (34) | **ciclo completo de desempate** |
| | `voter-validation.test.ts` (6) | normalização, anti-enumeração, sessão |
| **ACL** | `function-grants.test.ts` (6) | `anon`/`authenticated` barrados nas funções administrativas; payload público com campos exatos |
| **concorrência** | dentro de `desempate-runoff` | criação simultânea de desempate |
| **unit/segurança** | `csp.test.ts` (5) | `unsafe-eval` só em dev; diretivas não enfraquecidas |
| | `vote-session-cookies.test.ts` (7) | leitura não escreve cookie; chave de rascunho estável e distinta |
| | `ballot-draft-isolation.test.ts` (7) | rascunho não vaza entre eleitores |
| **unit/cache** | `cache-invalidation.test.ts` (9) | cada mutação invalida as tags certas |
| **unit/lógica** | `countdown.test.ts` (7), `live-state.test.ts` (12), `ballot-options.test.ts` (4), `active-election.test.ts` (5), `schemas.test.ts` (12), `draft.test.ts` (6), `phases.test.ts` (4), `voter-validation-flow.test.ts` (6) | |

**Vários testes foram validados por mutation testing** — removendo a correção e confirmando que o teste quebra. Se você alterar um comportamento protegido, o teste **deve** falhar; se não falhar, o teste está fraco.

---

## 17. Simulações manuais já executadas

**Ambiente**: projeto Supabase **separado, exclusivo para testes**, com as migrations `0001`–`0012` e o seed oficial. Dados fictícios: 19 candidatos, 5 eleitores.

**Simulação 1 — eleição sem empate: VALIDADA de ponta a ponta.**

Resultado observado: 5 cédulas, 65 escolhas, 5 links de auditoria, 5 eleitores com `has_voted`, 100% de participação, encerramento manual, apuração correta, publicação, `/resultados` correto, status final `resultado_disponivel`.

Três bugs encontrados durante ela (§13, itens 6, 7, 8) e corrigidos. Dois outros (5 e 9) surgiram da auditoria do cenário "mesmo dispositivo em sequência", que a simulação não cobria.

**Simulação 2 — desempate: AINDA NÃO EXECUTADA.** Cenário planejado: Presidente com Ana 2 × Bruno 2 × Nulo 1 (1 vaga) → desempate → Ana 3 × Bruno 2.

---

## 18. Estado atual do desenvolvimento

### IMPLEMENTADO E VALIDADO END-TO-END
- Eleição geral completa: validação, urna, revisão, voto, encerramento, apuração, publicação, `/resultados`
- Páginas públicas informativas
- Painel administrativo: login, dashboard, candidatos, cronograma, votação, resultados, segurança

### IMPLEMENTADO, COM TESTES, MAS SEM VALIDAÇÃO END-TO-END EM AMBIENTE REAL
- **Ciclo completo de desempate** (migrations `0013`–`0015`) — coberto por 34 testes de integração contra Postgres real, **nunca executado pela interface**
- Cache por tag e invalidação — validado em produção parcialmente (etapa 1A foi mergeada)
- Estado ao vivo com polling — verificado em Chromium contra stub, não contra Supabase real
- Correções de CSP, cookie, countdown, rascunho e rate limit — verificadas em Chromium; **as `0013`–`0015` não foram aplicadas em nenhum banco real**
- Resolução de cargo duplo (`resolve_dual_winner_decision`) — testes de integração, nunca exercitada manualmente

### PENDENTE / PLANEJADO
- **Etapa 2 de observabilidade** (planejada e aprovada, **não iniciada**): tabelas `performance_metrics`/`backend_performance_metrics`, Web Vitals, `@vercel/speed-insights`, página `/admin/performance` com p75, retenção de 30 dias via Vercel Cron. Decisões já tomadas: limiar de amostra insuficiente = 30; coleta de backend a 100% via `after()`; `device_class` só mobile/desktop.
- **Etapa 3** (consolidar validação do eleitor numa RPC; candidato + cargos transacional) — só mediante aprovação explícita
- Migração para Supabase Auth com contas individuais
- Criptografia adicional da camada de auditoria

---

## 19. Trabalho em andamento

**Tarefa mais recente: fluxo completo de desempate, etapas 2A (banco) e 2B (aplicação). Ambas concluídas e enviadas na PR #4. Não há implementação pela metade.**

O próximo passo previsto **não é código**: é aplicar `0013`, `0014` e `0015` no Supabase de TESTE e executar a Simulação 2 pela interface. Só depois disso o desempate deve ser considerado validado.

**Decisões já tomadas** (confirmadas pelo responsável, não inventadas):
- votos por eleitor no desempate = vagas em disputa, com repetição permitida
- empates simultâneos → urna combinada (um desempate cobre N cargos)
- novo empate → rodada filha, nunca decisão automática
- exibição pública → selo de origem + votos das duas rodadas

**Riscos**: a `0014` substitui as três funções do caminho validado na Simulação 1.

---

## 20. Alterações recentes relevantes

1. **`da80ced` — cache por tag.** Leitores estáveis com `unstable_cache` + `revalidate: false`. `trackPageView` para `after()`. Criou `lib/cache/tags.ts`.
2. **`f5b1a16` — botão de invalidação manual**, iterando `CACHE_TAGS`.
3. **`dc83c67` — consolidação em RPCs únicos + estado ao vivo.** Migration `0012`. Home e painel passam a 1 requisição. Dividiu `status.ts`/`phases.ts` em módulos puros (`status-values.ts`, `phase-bounds.ts`) porque componentes de cliente não podem importar `server-only`.
4. **`947bafb` — cinco correções da auditoria**: CSP por ambiente, cookie de confirmação, hidratação do countdown, isolamento do rascunho, tetos de rate limit.
5. **`38d1a1f` + `c908d4b` — desempate completo.** Migrations `0013`–`0015`. Mudança de modelo: um desempate cobre N cargos.

---

## 21. Áreas de alto risco

| Área | Risco |
|---|---|
| **Migrations** | Editar uma aplicada quebra bancos existentes silenciosamente |
| **GRANT / `service_role`** | Já quebrou produção 2×. `BYPASSRLS` ≠ acesso irrestrito |
| **`SECURITY DEFINER`** | Esquecer `SET search_path` abre escalada de privilégio |
| **`cast_ballot`** | A função mais crítica. Qualquer mudança pode aceitar cédula inválida ou permitir voto duplo |
| **RLS de `result_snapshots`** | Afrouxar vaza resultado antes da hora |
| **Invalidação de cache** | Esquecer um `updateTag` deixa dado velho **para sempre** (`revalidate: false`) |
| **Cookies** | Modificar em Server Component lança em runtime, não em build |
| **Rascunho da urna** | Voltar à chave fixa reintroduz vazamento entre eleitores |
| **Concorrência no desempate** | Remover o índice parcial permite dois desempates e trava a publicação |
| **Resolução do pai** | Se deixar de ser transacional, volta o `TIE_PENDING` eterno |
| **CSP** | `unsafe-eval` vazar para produção |
| **Hidratação** | Qualquer `Date.now()`/`window` em render |
| **Publicação** | Remover um dos três bloqueios publica resultado incompleto |

---

## 22. Regras para alterações futuras

- **Antes de criar migration**: `ls supabase/migrations/` e use o próximo número. Nunca edite as existentes.
- **Antes de criar RPC**: copie o padrão de `0014` — `SECURITY DEFINER` + `SET search_path` + `REVOKE` + `GRANT` + teste em `function-grants.test.ts`.
- **Antes de reescrever uma função existente**: encontre a **última** migration que a define (`grep -l "function public.X" supabase/migrations/*.sql | tail -1`). Bug #10 nasceu de ignorar isso.
- **Antes de mexer em cache**: leia `lib/cache/tags.ts` e a matriz (§10). Toda mutação nova precisa de teste em `cache-invalidation.test.ts`.
- **Antes de tocar em votação/apuração/desempate**: `npm run test:integration` antes e depois.
- **Antes de mexer em cookie**: confirme que o chamador é Server Action ou Route Handler.
- **Ao adicionar campo a payload público**: o teste de "campos exatos" vai falhar — isso é proposital. Atualize deliberadamente, não afrouxe a asserção.
- **Nunca confie no frontend** para regra crítica.
- **Se uma regra eleitoral não estiver definida: PERGUNTE.**

---

## 23. Comandos

```bash
npm install

npm run dev                 # Turbopack
npm run build
npm start

npm test                    # unitários
npm run test:integration    # exige Postgres local
npm run test:all
npm run test:watch

npm run lint
npx tsc --noEmit

npx supabase migration list
npx supabase db push --dry-run
npx supabase db push
```

---

## 24. Variáveis de ambiente

Validadas por Zod em `lib/env.ts` (falha no boot se faltar). Template em `.env.example`.

| Nome | Pública? | Finalidade | Onde |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **sim** | URL do projeto | todos |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **sim** | chave anônima (sujeita a RLS) | todos |
| `SUPABASE_SERVICE_ROLE_KEY` | **não** | backend confiável | todos |
| `ADMIN_PASSWORD_HASH` | **não** | hash bcrypt da senha administrativa | todos |
| `APP_SECRET_KEY` | **não** | HMAC de IPs e chaves derivadas (mín. 16 chars) | todos |
| `AUDIT_ENCRYPTION_KEY` | **não** | reservada, **não utilizada** | — |

⚠️ **`ADMIN_PASSWORD_HASH` contém `$`**, que o Next expande como referência a outra variável nos arquivos `.env`. Escape cada `$` como `\$`.

---

## 25. Deploy

Frontend na Vercel (deploy automático no merge para `main`); banco no Supabase.

**Ordem segura quando houver migration: MIGRATION PRIMEIRO, depois o código.**

As migrations do projeto são aditivas, então o código antigo continua funcionando com o banco novo — mas o inverso não é verdade. Código novo com banco velho falha com `permission denied for function`.

⚠️ **O preview da Vercel usa as mesmas variáveis de ambiente da produção** — logo, o mesmo Supabase. Um preview de PR com migration pendente responde 500 até a migration ser aplicada. Isso é esperado.

**Rollback**: promover o deploy anterior na Vercel. As funções novas no banco não atrapalham o código antigo, que não as chama. `docs/DEPLOY_V2.md` tem o roteiro completo, incluindo a query de conferência de GRANTs.

---

## 26. Produção vs teste

Existe um **projeto Supabase separado, exclusivo para simulações**. Todas as simulações devem rodar nele.

- **Nunca aponte desenvolvimento para o banco de produção.** Com `voters` reais e votação aberta, um teste vira voto real e `audit_vote_links` impede desfazer.
- Para apontar para o TESTE: troque `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` no `.env.local`. Como `NEXT_PUBLIC_*` é inlined no build, **rebuild é obrigatório**.
- O banco TEST está hoje com `0001`–`0012`; **`0013`–`0015` ainda precisam ser aplicadas** antes da Simulação 2.
- Para testes de integração existe ainda um Postgres **local** (`eleicao_test`), sem PostgREST — por isso os testes usam `pg` direto.

---

## 27. Dívida técnica e limitações conhecidas

| Limitação | Impacto | Bloqueia produção? | Workaround |
|---|---|---|---|
| Cache não invalida em edição direta no banco | dado velho no site | não | botão em `/admin/dashboard` |
| Senha administrativa única | sem trilha por pessoa | não (decisão explícita) | `admin_logs` registra as ações |
| Auditoria sem criptografia adicional | `audit_vote_links` protegida só por RLS/ACL | não | acesso restrito a `service_role` |
| Sem verificação em navegador do fluxo de desempate | risco visual | **sim, até a Simulação 2** | testes de integração |
| Node não fixado | build divergente entre ambientes | não | Vercel usa sua versão padrão |
| Observabilidade não iniciada | sem métricas de campo | não | — |
| `/votar/revisao` bounce em carga direta | UX menor | não | — |
| Testes de timers/Page Visibility ausentes | polling sem cobertura automatizada | não | exigiria jsdom + testing-library |

---

## 28. Decisões deliberadas — não reabrir sem motivo

1. **Regra crítica no PostgreSQL**, não no TypeScript — atomicidade e imunidade a cliente malicioso.
2. **Todas as rotas `force-dynamic`** — status e sessão nunca podem vir de HTML estático.
3. **`unstable_cache` em vez de `cacheComponents`** — a flag mudaria o modelo de renderização de 19 rotas num app com nonce por requisição.
4. **`revalidate: false`** — dado eleitoral não deve "expirar sozinho"; muda quando o admin muda.
5. **CSP com nonce + `strict-dynamic`** — remover o nonce reabre XSS.
6. **`unsafe-eval` só em dev** — medido, não suposto.
7. **Nulo como flag, nunca candidato.**
8. **Denormalização em `result_snapshots`** — o resultado histórico sobrevive à desativação de candidato ou cargo.
9. **Desempate cobre N cargos** — uma eleição por cargo quebraria a atomicidade da cédula.
10. **Resolução do pai dentro de `publish_results`** — passo separado reabriria a janela do `TIE_PENDING` eterno.
11. **Candidatos e vagas do desempate derivados do banco.**
12. **Rate limit assimétrico** (IP 100, matrícula 10) — rede compartilhada é esperada; o controle real é por matrícula.
13. **Rascunho por sessão** — dispositivo compartilhado é o caso de uso real.
14. **`vote_confirmed` só lido** — Server Component não modifica cookie, e uso único estrito não valia a complexidade.
15. **`get_current_voting_election` falha alto em ambiguidade** — escolher sozinha seria inventar regra eleitoral.

---

## 29. Divergências encontradas

**Confirmadas por inspeção; nenhuma foi resolvida silenciosamente.**

| # | Documentação diz | Código faz | Fonte da verdade | Recomendação |
|---|---|---|---|---|
| 1 | `TECHNICAL_DESIGN.md` §14 cita a função `cast_runoff_ballot` | **não existe** — `cast_ballot` cobre os dois casos | código | corrigir o documento |
| 2 | `TECHNICAL_DESIGN.md` cita `POST /api/admin/runoffs` | **não existe** — é Server Action; só há `app/api/public/live-state` | código | corrigir o documento |
| 3 | `README.md` "Limitações conhecidas": *"a interface pública de `/votar` hoje assume a eleição geral... a tela de urna não distingue múltiplas eleições"* | **obsoleto desde `c908d4b`** — a etapa 2B resolveu | código | **remover esse item do README** |
| 4 | `TECHNICAL_DESIGN.md` linha 3: "Status: **implementado**... a implementação está completa" | escrito antes das etapas 1A/1B/2A/2B | git log | atualizar o cabeçalho |
| 5 | `TECHNICAL_DESIGN.md` descreve `result_snapshots` sem `tie_break_needed`, `candidate_name`, `candidate_photo_path`, `position_name` | schema real tem todos (`0002` + `0008`) | migrations | atualizar o documento |
| 6 | `PERFORMANCE_V2.md` cita região `gru1` | **nenhum arquivo de config da Vercel no repositório** | indeterminado | confirmar no painel da Vercel |

**Nenhuma divergência afeta comportamento em runtime** — todas são documentação desatualizada. Mas a #3 é a mais perigosa: um agente que leia o README pode reimplementar algo que já existe.

---

## INSTRUÇÕES AO CODEX

1. **Leia este handoff inteiro antes de alterar qualquer arquivo.**
2. **Confira o estado atual da branch e do HEAD.** Este documento retrata `c908d4b`; o repositório pode ter avançado.
3. **Não assuma que documentação antiga supera o código.** Onde divergirem, o código vence — e veja §29, que lista as divergências conhecidas.
4. **Preserve todas as invariantes de §9.** Se uma mudança sua exigir quebrar alguma, pare e pergunte.
5. **Não edite migrations já aplicadas.**
6. **Toda mudança de banco = migration nova**, com o próximo número livre (hoje `0016`).
7. **Alteração em segurança exige teste** — ACL, RLS, CSP, cookie, rate limit.
8. **Alteração em cache exige teste de invalidação** em `tests/unit/cache-invalidation.test.ts`.
9. **Alteração em fluxo crítico exige testes de integração** — voto, apuração, publicação, desempate.
10. **Antes de concluir qualquer tarefa, rode e deixe verde:**
    ```bash
    npm test
    npm run test:integration
    npm run lint
    npx tsc --noEmit
    npm run build
    ```
    Se os de integração falharem com `ECONNREFUSED 5432`, é o Postgres parado — religue antes de concluir que houve regressão.
11. **Não faça deploy automaticamente.**
12. **Não faça merge na `main` sem autorização.**
13. **Se uma decisão afetar regra de negócio e não estiver definida no código, nos testes ou no `TECHNICAL_DESIGN.md`: PERGUNTE.** Não invente regra eleitoral — nem critério de desempate, nem contagem de votos, nem quem pode votar.

Uma observação final de método: vários bugs deste projeto passaram por testes que *pareciam* cobri-los. Quando escrever um teste para uma correção, **verifique que ele falha se você reverter a correção**. Um teste que passa nos dois estados não protege nada.