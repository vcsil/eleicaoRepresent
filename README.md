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
   ```
4. Rode `supabase/seed.sql` para cadastrar a eleição principal, os 6 cargos
   (13 vagas) e o cronograma oficial (seção 7 do documento técnico) — os
   horários exatos de cada fase ficam com o valor padrão 00:00–23:59:59 até
   serem configurados em `/admin/cronograma`.
5. Gere o hash da senha administrativa e defina `ADMIN_PASSWORD_HASH`.
6. Cadastre os eleitores habilitados na tabela `voters` (matrícula + nome
   completo) — não há tela para isso, é feito diretamente no banco pela
   administração, mantendo a lista fora de qualquer rota pública.

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
