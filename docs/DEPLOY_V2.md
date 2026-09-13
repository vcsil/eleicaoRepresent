# Handoff de deploy — segundo deploy (etapas 1A e 1B)

Este documento é o roteiro para colocar as etapas 1A e 1B em produção.
Nada aqui foi aplicado automaticamente: eu não tenho acesso ao projeto
Supabase nem ao Vercel.

---

## 1. Ordem de execução

A **migration `0012` tem que ser aplicada antes (ou junto com) o deploy do
código.** Ela não é opcional nesta versão: a home e o painel passaram a
chamar as funções novas. Se o código subir antes da migration, as duas
páginas falham com `permission denied for function ...`.

Se preferir margem zero de risco, aplique a migration primeiro: ela é
aditiva e o código antigo continua funcionando sem ela (não chama as
funções novas).

```
1. migration 0012 no Supabase
2. deploy do código no Vercel
```

---

## 2. Aplicar a migration

### Opção A — Supabase CLI (recomendada)

```bash
# confere o que o projeto remoto já tem e o que falta
npx supabase migration list

# mostra o que SERIA aplicado, sem aplicar
npx supabase db push --dry-run

# aplica
npx supabase db push
```

### Opção B — SQL Editor do painel

Cole o conteúdo de `supabase/migrations/0012_dashboard_and_live_state.sql`
e execute. É um arquivo só, sem dependência de ordem interna.

### O que a migration faz

Cria duas funções e nada mais. **Não** altera tabelas, **não** altera
funções existentes, **não** mexe em RLS, **não** mexe em dados.

| Função | Quem pode executar |
|---|---|
| `get_admin_dashboard_metrics(uuid)` | só `service_role` |
| `get_live_election_state(uuid)` | `anon`, `authenticated`, `service_role` |

### Conferir que os GRANTs ficaram certos

Rode isto no SQL Editor depois de aplicar. É a verificação que teria
evitado os dois rounds de bug de permissão anteriores:

```sql
select
  p.proname,
  pg_catalog.has_function_privilege('anon',          p.oid, 'execute') as anon,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
  pg_catalog.has_function_privilege('service_role',  p.oid, 'execute') as service_role
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_admin_dashboard_metrics', 'get_live_election_state');
```

Esperado:

| proname | anon | authenticated | service_role |
|---|---|---|---|
| `get_admin_dashboard_metrics` | **f** | **f** | t |
| `get_live_election_state` | t | t | t |

Se `anon` aparecer `t` na primeira linha, **pare**: a função
administrativa ficou alcançável pela chave pública. Rode
`revoke all on function public.get_admin_dashboard_metrics(uuid) from public, anon, authenticated;`
e confira de novo.

---

## 3. Variáveis de ambiente

**Nenhuma nova.** Nada a alterar no Vercel nesta etapa.

---

## 4. Configuração manual no Vercel

**Nenhuma.** A rota `/api/public/live-state` é uma Route Handler comum, já
incluída no build. Sem cron, sem integração, sem mudança de região.

(A retenção de 30 dias por Vercel Cron, que você aprovou, é da **etapa
2** — não existe ainda.)

---

## 5. Testes depois do deploy

Na ordem, tudo pela interface:

1. **Home** carrega e mostra o badge de status correto.
2. **`/api/public/live-state`** aberta direto no browser devolve um JSON com
   exatamente quatro campos: `status`, `participation`, `serverTime`,
   `votingOpen`. Se aparecer qualquer outro campo, algo saiu errado.
3. **`/admin/dashboard`** mostra todos os cartões com números (não
   zerados, se já houver dados). Aqui é onde a falta da migration
   apareceria.
4. **Botão "Atualizar dados do site"** em `/admin/dashboard` responde com
   "Dados atualizados".
5. **Teste do cache**: altere o nome de um candidato em `/admin/candidatos`
   e confirme que `/candidatos` mostra o novo nome imediatamente.
6. **Durante a votação** (ou numa janela de teste com o cronograma
   apontando para agora): abra a home, deixe a aba aberta e confirme que a
   barra de participação atualiza sozinha depois de ~30s quando alguém
   vota. Troque de aba e volte: deve atualizar na hora.
7. **Votar**: uma validação de eleitor completa, de ponta a ponta. Os rate
   limits passaram a rodar em paralelo — este teste confirma que a
   validação segue funcionando.

---

## 6. Riscos

| Risco | Gravidade | Mitigação |
|---|---|---|
| Código no ar sem a migration 0012 | **alta** — home e painel quebram | aplicar a migration primeiro (passo 1) |
| `get_admin_dashboard_metrics` acessível a `anon` | **alta** — contagens de eventos de segurança vazariam | a query de conferência do passo 2; coberto por teste de integração |
| Polling gerando carga inesperada | baixa | 1 requisição por aba a cada 30s, só durante a votação, e só com a aba em foreground |
| Cache servindo dado velho após edição direta no banco | média | botão "Atualizar dados do site" em `/admin/dashboard` |
| Relógio do visitante desregulado | nenhuma para o pleito | a hora do servidor acompanha o estado ao vivo e é usada só para exibição; autorização de voto é sempre server-side |

---

## 7. Rollback

### Código

Reverter o deploy no Vercel (Deployments → deploy anterior →
"Promote to Production"). O código anterior não chama as funções novas,
então volta a funcionar imediatamente, **sem** precisar desfazer a
migration.

### Migration

Normalmente não é necessário: a `0012` é aditiva e deixar as funções no
banco não afeta o código antigo. Se ainda assim quiser remover:

```sql
drop function if exists public.get_admin_dashboard_metrics(uuid);
drop function if exists public.get_live_election_state(uuid);
```

Não há perda de dados em nenhuma direção — as duas funções são apenas
leitura.

### O que NÃO fazer

Não edite as migrations já aplicadas (0001–0011) para tentar corrigir
algo: crie uma `0013` nova. Migration aplicada é histórico.
