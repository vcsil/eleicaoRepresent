# Eleição da Comissão de Formatura — Turma 36 (Medicina UniEVANGÉLICA)

Aplicação web para centralizar informações e a votação da Comissão de
Formatura: cronograma, cargos, candidatos, votação por distribuição de
votos, apuração, publicação de resultados, administração e auditoria.

Arquitetura completa, schema do banco e o racional de cada decisão de
segurança estão documentados em **[`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md)** —
leia esse arquivo para entender o "porquê" das escolhas abaixo.

Estratégia de cache, invalidação por tag e as medições de performance
estão em **[`docs/PERFORMANCE_V2.md`](docs/PERFORMANCE_V2.md)**.

## Stack

- Next.js 16 (App Router) + TypeScript + React 19
- Tailwind CSS 4 (tokens de design centralizados em `app/globals.css`)
- Supabase (Postgres + Storage) — toda regra de negócio sensível vive em
  funções `SECURITY DEFINER` no Postgres, não só no código Next.js
- Zod para validação de toda entrada sensível
- Vitest (+ `pg` para os testes de integração)

## Requisitos

- Node.js 20+
- Uma conta/projeto [Supabase](https://supabase.com) (para rodar contra dados
  reais) — para desenvolvimento local sem Supabase, veja "Testes" abaixo
- Postgres local (opcional, só para rodar os testes de integração e para
  validar migrations antes de aplicá-las no Supabase)

## Instalação

```bash
npm install
cp .env.example .env.local
```

Preencha `.env.local` com os valores do seu projeto Supabase (veja a seção
"Variáveis de ambiente"). **Importante**: hashes bcrypt contêm `$`, que o
Next.js tenta expandir como referência a outra variável — escape cada `$`
como `\$` no `.env.local` (o `.env.example` traz um exemplo).

## Variáveis de ambiente

| Variável | Pública? | Descrição |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Sim | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Sim | Chave anônima (sujeita a RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Não** | Só em Server Actions/Route Handlers; nunca no navegador |
| `ADMIN_PASSWORD_HASH` | **Não** | Hash bcrypt da senha administrativa — gere com `node -e "console.log(require('bcryptjs').hashSync('SUA_SENHA', 12))"` |
| `APP_SECRET_KEY` | **Não** | Segredo para HMAC de IPs (pseudonimização em `security_events`) |
| `AUDIT_ENCRYPTION_KEY` | **Não** | Reservado para a futura camada de criptografia da auditoria (não usado ainda) |

Nunca use o prefixo `NEXT_PUBLIC_` em nenhuma das variáveis marcadas "Não".

## Configuração do Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. Copie a URL e as chaves (`anon` e `service_role`) em Project Settings → API
   para o `.env.local`.
3. Aplique as migrations, em ordem, contra o banco do projeto (SQL Editor do
   painel, ou `psql "$DATABASE_URL" -f supabase/migrations/000X_*.sql` para
   cada arquivo, ou a Supabase CLI: `supabase db push`):
   ```
   supabase/migrations/0001_extensions.sql
   supabase/migrations/0002_schema.sql
   supabase/migrations/0003_status_and_helpers.sql
   supabase/migrations/0004_voting_functions.sql
   supabase/migrations/0005_results_functions.sql
   supabase/migrations/0006_rls.sql
   supabase/migrations/0007_storage.sql
   supabase/migrations/0008_result_snapshot_denormalization.sql
   supabase/migrations/0009_analytics.sql
   supabase/migrations/0010_fix_service_role_grants.sql
   supabase/migrations/0011_grant_service_role_tables.sql
   supabase/migrations/0012_dashboard_and_live_state.sql
   supabase/migrations/0013_runoff_multi_position_schema.sql
   supabase/migrations/0014_runoff_functions.sql
   supabase/migrations/0015_live_state_follows_active_election.sql
   supabase/migrations/0016_admin_session_idle_timeout.sql
   supabase/migrations/0017_import_voters.sql
   supabase/migrations/0018_admin_idle_timeout_10min.sql
   ```
4. Rode `supabase/seed.sql` para cadastrar a eleição principal, os 6 cargos
   (13 vagas) e o cronograma oficial (seção 7 do documento técnico) — os
   horários exatos de cada fase ficam com o valor padrão 00:00–23:59:59 até
   serem configurados em `/admin/cronograma`.
5. Gere o hash da senha administrativa e defina `ADMIN_PASSWORD_HASH`.
6. Cadastre os eleitores habilitados em `/admin/eleitores`, importando a
   lista oficial em `.csv` ou `.xlsx` (matrícula + nome completo). A lista
   fica fora de qualquer rota pública — `voters` não tem policy de leitura
   para `anon`. Também é possível inserir direto no banco, se preferir.

O bucket de Storage `candidate-photos` (fotos dos candidatos) é criado pela
migration `0007_storage.sql`.

> **Já aplicou as migrations 0001-0009 antes de 10/2026?** Um `REVOKE ALL
> ... FROM PUBLIC` em várias funções também removia, sem querer, o acesso
> implícito que `service_role` herdava de `PUBLIC` (`service_role` só tem
> `BYPASSRLS` — ignora *policies* de RLS — mas continua sujeito à ACL normal
> de `GRANT`/`REVOKE`), e `compute_election_status` não era `SECURITY
> DEFINER`. Isso quebrava login, validação do eleitor, envio de voto,
> apuração, publicação e desempates com "permission denied for function/
> table ...". Basta rodar `supabase/migrations/0010_fix_service_role_grants.sql`
> no projeto existente — não precisa reaplicar nada anterior.
>
> **Já aplicou até a 0010 e ainda vê "permission denied for table ..."
> (ex.: ao logar em `/admin`)?** Diferente de funções (que recebem
> `EXECUTE` a `PUBLIC` por padrão na criação), tabelas não recebem
> nenhum privilégio a `PUBLIC` — e nenhuma migration anterior jamais
> concedeu nada a `service_role` em nenhuma tabela, então todo acesso
> direto (`.from(tabela)`, fora das funções `SECURITY DEFINER`) estava
> quebrado. Rode `supabase/migrations/0011_grant_service_role_tables.sql`
> no projeto existente.
>
> **Já aplicou até a 0011?** A `0012_dashboard_and_live_state.sql` só
> adiciona duas funções de leitura consolidada
> (`get_admin_dashboard_metrics`, usada pelo painel, e
> `get_live_election_state`, usada pela home durante a votação). Não altera
> nenhuma tabela nem nenhuma função existente; aplicar é seguro a qualquer
> momento. **Antes de aplicar**, o painel e a home falham com "permission
> denied for function ..." — as duas passaram a depender dela.
>
> **Já aplicou até a 0017?** A `0018_admin_idle_timeout_10min.sql` estende a
> janela de inatividade do painel administrativo de 5 para 10 minutos. Ela
> substitui `check_admin_session` (a `0016` não é editada, porque já está
> aplicada) e estende as sessões abertas no momento para a janela nova, em
> vez de deixá-las com o prazo antigo até o próximo heartbeat.
>
> O intervalo vive em dois lugares — dentro de `check_admin_session` e em
> `ADMIN_IDLE_TIMEOUT_SECONDS` (`lib/admin/session-config.ts`) — e os dois
> **precisam coincidir**: se o servidor conceder menos tempo do que a
> interface acredita ter, o administrador é deslogado no meio de uma
> operação, sem aviso. Aplicar o código sem esta migration produz exatamente
> essa divergência. Um teste de integração compara a constante com o
> intervalo que o banco de fato concede e quebra se divergirem.

## Desenvolvimento

```bash
npm run dev       # servidor de desenvolvimento (Turbopack)
npm run lint      # eslint
npx tsc --noEmit  # checagem de tipos
```

### Testes

```bash
npm test               # unitários — sem dependências externas
npm run test:integration  # integração — requer Postgres local com as migrations aplicadas
npm run test:all       # ambos
```

Para os testes de integração, aponte `TEST_DATABASE_URL` para um Postgres
local com as migrations de `supabase/migrations/` já aplicadas (schema
idêntico ao do Supabase — as mesmas funções/RLS podem ser testadas em
qualquer Postgres 15+, sem precisar de um projeto Supabase real):

```bash
createdb eleicao_test
for f in supabase/migrations/*.sql; do psql "$TEST_DATABASE_URL" -f "$f"; done
TEST_DATABASE_URL="postgresql://usuario:senha@localhost:5432/eleicao_test" npm run test:integration
```

Os testes cobrem: normalização de nome (acentos/maiúsculas/espaços),
validação do eleitor (matrícula inexistente, nome incorreto, inativo, já
votou), toda a matriz de distribuição de votos da seção 93 do documento
técnico (repetição no mesmo candidato, votos nulos parciais/totais, soma
incorreta, valores negativos/decimais, candidato inválido ou de outro
cargo, payload adulterado), atomicidade e concorrência (duas submissões
simultâneas da mesma sessão — só uma vence), apuração (empates, nulos
contabilizados à parte, votos repetidos somados corretamente), a promoção
do próximo colocado quando um candidato eleito em dois cargos escolhe um
deles, e a política de RLS (resultados só visíveis após publicação).

## Build e deploy

```bash
npm run build
npm start
```

Ambiente alvo: [Vercel](https://vercel.com) (Next.js) + Supabase Cloud.
Configure as mesmas variáveis de ambiente do `.env.local` no painel do
provedor de hospedagem. Como todas as páginas que dependem de dados da
eleição são renderizadas dinamicamente (`export const dynamic =
"force-dynamic"` — status, participação e resultados nunca podem vir de
cache estático), nenhuma etapa extra de revalidação é necessária.

## Arquitetura e segurança (resumo)

- **Toda operação sensível roda no servidor.** Validação do eleitor, envio
  de voto, login administrativo, apuração e publicação são Server
  Actions/Route Handlers usando a chave `service_role`; o navegador nunca
  fala diretamente com regras de negócio.
- **A votação é atômica.** `cast_ballot` é uma função `SECURITY DEFINER` no
  Postgres que trava a linha do eleitor, revalida a fase da eleição pela
  hora do servidor, recalcula a soma de cada cargo a partir das
  quantidades individuais (nunca aceita um total pré-calculado do
  cliente) e registra tudo em uma única transação.
- **Um voto por eleitor é garantido estruturalmente**, não só por uma
  flag: `audit_vote_links` tem `UNIQUE (election_id, voter_id)`.
- **O vínculo eleitor→voto fica isolado.** `ballots` não tem `voter_id`; a
  única tabela que liga eleitor a voto é `audit_vote_links`, com RLS que
  nega qualquer leitura pública — nenhuma rota administrativa comum a
  consulta.
- **RLS nega por padrão.** Só o conteúdo explicitamente público (cargos,
  candidatos ativos, cronograma, resultados após publicação) tem policy de
  leitura para `anon`/`authenticated`.
- **Detalhes completos**: seções 4-15 de `docs/TECHNICAL_DESIGN.md`.

## Fluxo de desempate

**Como o empate é detectado.** `compute_results` marca `tie_break_needed`
apenas no grupo de candidatos que *cruza* a linha de corte das vagas —
empate fora dela não gera pendência.

**Como a publicação é bloqueada.** `publish_results` recusa enquanto
houver `tie_break_needed`, decisão de cargo duplo pendente, ou eleição
filha não publicada.

**Como o desempate é criado.** `create_runoff_election(pai, cargos[],
motivo, cronograma)` recebe **apenas** quais cargos e quando. Os
candidatos saem de `result_snapshots` (os empatados daquele cargo) e as
vagas em disputa são derivadas: vagas do cargo menos os já eleitos. Nada
que decida o resultado vem do navegador. Um índice parcial em
`runoff_positions` impede dois desempates abertos para o mesmo cargo —
duplo clique é barrado no banco, não no botão.

**Um desempate cobre N cargos.** Se houver empate em cargos diferentes,
tudo entra numa única eleição de desempate: uma sessão, uma cédula, um
`audit_vote_links`, como na geral. Por isso no máximo uma eleição fica
aberta por vez, e `get_current_voting_election()` resolve qual é sem
ambiguidade.

**Como o eleitor vota de novo.** A unicidade é `(election_id, voter_id)`
em `audit_vote_links`, então quem votou na geral vota uma vez no
desempate — e só uma.

**Como o desempate resolve a eleição principal.** `publish_results` de um
desempate chama `resolve_parent_ties_from_runoff` na **mesma transação**:
os N mais votados viram `elected = true` nos snapshots do *pai*, o grupo
empatado deixa de ser pendência, os perdedores ficam não eleitos, e cada
vaga resolvida gera uma linha em `runoff_resolutions` (com os votos do
desempate). Os `votes_count` da eleição original **não são alterados** —
os dois pleitos são registros distintos. Ser transacional é o que impede
o estado que existia antes: desempate publicado e pai travado em
`TIE_PENDING` para sempre.

**Como o eleitor chega à urna do desempate.** `/votar` não resolve mais
"a eleição geral", e sim a votação efetivamente aberta
(`get_current_voting_election`). A urna e a revisão, por sua vez, usam a
eleição da **sessão** do eleitor, não a que estiver aberta no momento: se
a votação virasse entre a validação e o envio, a pessoa veria uma cédula
que sua sessão não autoriza. Na urna do desempate aparecem apenas os
cargos em disputa, os candidatos empatados e a opção Nulo.

**O que a home mostra.** Havendo votação aberta — geral ou desempate —,
`get_live_election_state` devolve o estado *dela*, e a home exibe
"Votação de desempate em andamento" com o botão apontando para a urna.
Antes ficava em "Desempate necessário", verdade sobre a eleição principal
e inútil para quem precisava votar.

**O que o resultado público mostra.** Quem foi eleito por desempate
aparece com o selo "Eleito por desempate", e a votação de desempate é
exibida como um bloco próprio, abaixo da votação original — as duas
rodadas lado a lado, cada uma com seus números.

**Se o desempate empatar de novo.** Nada é decidido automaticamente: a
pendência permanece, `publish_results` recusa, e o administrador cria uma
nova rodada — filha do desempate empatado. A cadeia de `RUNOFF_PENDING`
resolve em ordem.

## Importação de eleitores

`/admin/eleitores` carrega a lista oficial a partir de `.csv` ou `.xlsx`.

**Matrícula é sempre string.** No XLSX é lido o texto formatado da célula,
não o valor numérico — converter perderia zeros à esquerda, e `001234`
virar `1234` significa um eleitor que não consegue votar. Se a planilha já
salvou a matrícula como número, o zero se perdeu no arquivo e nenhuma
biblioteca o recupera.

**O preview não é a importação.** O navegador lê o arquivo para dar
resposta imediata, mas a Server Action **relê o arquivo original** e
revalida antes de gravar. O que o cliente mostra nunca é insumo da
gravação.

**Colunas**: reconhecidas por variações comuns de cabeçalho (`Matrícula`,
`matricula`, `RA`, `registration_number` / `Nome`, `Nome completo`,
`Aluno`, `full_name`), comparando sem acento e sem caixa. Quando não há
correspondência única — nenhuma, ou mais de uma candidata —, a tela pede
que o administrador escolha. Adivinhar por posição importaria a lista
inteira trocada.

**Gravação transacional** via `import_voters` (migration `0017`): um bloco
plpgsql, todas as linhas ou nenhuma. Inserts sequenciais pelo cliente
Supabase seriam ~100 requisições sem transação, e uma falha no meio
deixaria a lista pela metade.

**O que a importação NUNCA faz**: remover eleitores ausentes do arquivo,
resetar `has_voted`/`voted_at`, ou reativar quem está inativo. Eleitor já
cadastrado tem apenas o `full_name` atualizado — e isso muda
`normalized_name`, que é o campo comparado por `validate_voter`, então a
pessoa passa a precisar da grafia nova para votar. A pré-visualização
mostra cada alteração de nome antes da confirmação.

**Votação aberta não bloqueia**, mas exige confirmação explícita — revalidada
server-side — porque alterar a lista muda o total de habilitados e, com
ele, o percentual de participação do pleito em curso. O fato fica
registrado em `admin_logs` como `VOTERS_IMPORTED` com `during_open_voting`.

## Notas de arquitetura (segundo deploy)

**CSP difere entre ambientes.** Em desenvolvimento, `script-src` inclui
`'unsafe-eval'`; em produção, não. Não é descuido: o Fast Refresh do
Turbopack aplica hot updates via `eval`, e sem a diretiva toda edição de
componente força recarga completa da página (perdendo, por exemplo, a
distribuição de votos em andamento na urna). Em produção o bundle não
contém `eval` algum — a sonda do React está atrás de um gate
`"development"` —, então conceder a diretiva lá seria superfície de ataque
sem contrapartida. Travado por teste (`tests/unit/csp.test.ts`); nonce,
`strict-dynamic`, `frame-ancestors` e `object-src` são idênticos nos dois
ambientes.

**`vote_confirmed` é lido, não consumido.** A página `/voto-confirmado`
apenas lê o cookie — Server Components não podem modificar cookies. O
cookie expira sozinho em 5 minutos e é apagado quando um novo eleitor
valida os dados. Na prática: recarregar ou voltar para a tela de sucesso
funciona por alguns minutos. O cookie não autoriza nada eleitoral, só
decide se a tela de confirmação aparece.

**O rascunho da urna é isolado por sessão de voto.** A chave no
`sessionStorage` inclui um identificador derivado da sessão, e rascunhos
de outras sessões são apagados quando a urna abre. Isso existe para o
dispositivo compartilhado: sem o isolamento, um eleitor que abandona a
urna deixaria sua distribuição para o próximo, que a veria na tela e — se
estivesse completa — poderia enviá-la como se fosse dele.

**Rate limit da validação tem tetos distintos por dimensão.** Por IP,
100 tentativas/5 min: a turma inteira costuma sair pelo mesmo IP público,
e um teto baixo barraria eleitores legítimos em vez de atacantes. Por
matrícula, 10/5 min — este é o controle anti-força-bruta que importa.

## Rotas

Públicas: `/`, `/cargos`, `/candidatos`, `/votar`, `/votar/urna`,
`/votar/revisao`, `/voto-confirmado`, `/resultados`.

Administrativas (autenticação por senha única, sessão HttpOnly):
`/admin`, `/admin/dashboard`, `/admin/candidatos`, `/admin/cronograma`,
`/admin/votacao`, `/admin/resultados`, `/admin/desempates`,
`/admin/seguranca`.

## Limitações conhecidas / próximos passos

- Cargos, candidatos e cronograma são servidos do Data Cache e só são
  invalidados por ações do painel. **Se você alterar esses dados direto no
  banco** (SQL Editor do Supabase, `psql`), clique em "Atualizar dados do
  site" em `/admin/dashboard` — senão o site continua mostrando o valor
  antigo. Detalhes em [`docs/PERFORMANCE_V2.md`](docs/PERFORMANCE_V2.md).
- Autenticação administrativa por senha única está desenhada para migrar
  no futuro para Supabase Auth com contas individuais (seção 62 do
  documento técnico) — não implementado nesta fase, por decisão explícita.
- A camada de auditoria (`audit_vote_links`) está isolada estruturalmente,
  mas a criptografia adicional/credencial de acesso excepcional citada na
  seção 44 ainda não foi implementada — é evolução futura documentada, não
  parte do escopo atual.
- Votação de desempate reaproveita o mesmo fluxo de urna/validação, mas a
  interface pública de `/votar` hoje assume a eleição geral; votar em um
  desempate específico usa a mesma função `cast_ballot`/`validate_voter`
  no backend, porém a tela de urna não distingue múltiplas eleições
  simultâneas na UI — outra iteração validaria isso end-to-end com um
  projeto Supabase real.
