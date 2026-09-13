# Performance V2 — segundo deploy

Documento vivo desta iteração de performance. Registra baseline, o que
mudou, o que foi medido e o que ficou pendente.

Status: **Etapas 1A e 1B concluídas**. Etapas 2 e 3 pendentes.

---

## Como as medições foram feitas

Medir contra o Supabase real misturaria latência de rede variável com o
que se quer isolar: **quantas viagens ao banco cada rota faz**. Então as
medições usam um stub HTTP local que imita a API REST do Supabase
(`/rest/v1/*`) e registra cada requisição recebida.

- baseline: build do commit anterior à Etapa 1A (`225bfe4`)
- depois: build da Etapa 1A (`da80ced`)
- em ambos: `npm run build` + `npm start` (produção), Data Cache limpo
  (`rm -rf .next/cache`), 3 carregamentos consecutivos por rota

⚠️ **Sobre os tempos absolutos**: o stub roda em `localhost`, com latência
de rede praticamente zero. Os tempos abaixo, portanto, **subestimam** o
ganho real — em produção cada viagem eliminada custa uma ida e volta de
`gru1` até o Supabase. A métrica confiável aqui é a **contagem de
requisições**, não o cronômetro.

---

## Contagem de requisições ao Supabase (medida)

Por carregamento, em regime (após o primeiro acesso que preenche o cache):

| Rota | Antes | Depois | Observação |
|---|---|---|---|
| `/` (home) | 4 (`elections`, `election_phases`, `compute_election_status`, analytics) | **1 bloqueante** (`compute_election_status`) + analytics em `after()` | status é autoritativo e nunca será cacheado |
| `/cargos` | 2 (`positions`, analytics) | **0 bloqueante** + analytics em `after()` | |
| `/candidatos` | 3 (`candidates`, `positions`, analytics) | **0 bloqueante** + analytics em `after()` | |
| `/votar/urna` | 2 (`positions`, `candidates`) | **0** | herda os mesmos caches via `getBallotOptions()` |
| `/votar/revisao` | 2 (`positions`, `candidates`) | **0** | idem |

Tempo de resposta observado (localhost, portanto piso otimista):

| Rota | Antes (1º / 2º / 3º) | Depois (1º / 2º / 3º) |
|---|---|---|
| `/` | 180ms / 24ms / 21ms | 209ms / 20ms / 19ms |
| `/cargos` | 22ms / 18ms / 13ms | 176ms / 15ms / 13ms |

O primeiro acesso depois de uma invalidação continua pagando o custo da
consulta (cache miss) — é o comportamento desejado: "primeiro acesso →
Supabase → cache; próximos → cache".

---

## Etapa 1B — estado ao vivo e consolidação de round trips

### Contagem de requisições (medida, mesmo método)

| Rota | Antes da 1A | Depois da 1A | Depois da 1B |
|---|---|---|---|
| `/` durante a votação | 5 | 2 bloqueantes (`compute_election_status`, `get_participation_percentage`) | **1 bloqueante** (`get_live_election_state`) |
| `/` fora da votação | 4 | 1 bloqueante | **1 bloqueante** |
| `/admin/dashboard` | 9 | 9 | **1** (contado no código; a função foi exercitada em psql e nos testes de integração, não medida pelo stub — o painel exige sessão administrativa) |
| `/api/public/live-state` (por poll) | — | — | **1** |

Medido com o stub: home em regime faz `get_live_election_state` +
`increment_page_view` (este em `after()`, fora do caminho crítico);
`elections` e `election_phases` vêm do cache. Tempo na home: 20ms / 18ms /
19ms — de novo, localhost, piso otimista.

### As duas funções novas (migration 0012)

`get_admin_dashboard_metrics(uuid)` — **administrativa**. Substitui 7
consultas paralelas, duas das quais traziam TODAS as linhas de
`security_events` e de `site_access_stats` para contar e somar em
JavaScript: custo que crescia sem limite com o uso do site. Agora a
agregação é do Postgres. Inclui status e participação, então o painel
inteiro sai em uma chamada.

`get_live_election_state(uuid)` — **pública**. Devolve exatamente o que a
home já exibia: status, participação e hora do servidor.

Decisões de segurança, explícitas:

- A função administrativa tem `revoke ... from public, anon,
  authenticated` e `grant` só para `service_role`. anon/authenticated são
  os papéis que a chave pública do Supabase assume — sem o revoke,
  contagens de eventos de segurança seriam legíveis do browser. (Funções,
  diferente de tabelas, recebem EXECUTE a PUBLIC por padrão na criação.)
- A função pública devolve participação **apenas durante a votação**
  (seção 47). Fora dela, null. A regra está no Postgres, não no
  TypeScript.
- `server_time` é **display only**: serve para o countdown não depender do
  relógio do visitante. Nada no sistema autoriza voto com base em hora
  vinda do cliente.
- Nenhum resultado, parcial ou final, transita por nenhuma das duas.
- `/api/public/live-state` **não aceita parâmetro**: a eleição é resolvida
  no servidor por `getMainElection()`. Aceitar um `election_id` do cliente
  abriria sondagem de ids arbitrários (uma eleição de desempate ainda não
  divulgada, por exemplo).
- O endpoint responde com `Cache-Control: no-store`. A CSP não precisou de
  nenhuma alteração: `connect-src 'self'` já cobre o fetch do polling
  (verificado na resposta real do servidor).

### Polling

`LiveElectionProvider` é um provider de contexto, não um componente que
desenha tudo: as partes que precisam do estado ficam em seções distantes
da home (badge no hero, participação abaixo). Com contexto o polling
acontece **uma vez** e todos os consumidores leem o mesmo valor — dois
componentes independentes fariam duas requisições por ciclo e poderiam
mostrar números diferentes entre si.

- 30s de intervalo, **e só enquanto a votação está aberta**. Fora dela o
  polling não existe.
- Aba em background não consulta (Page Visibility); quem volta à aba
  recebe atualização imediata.
- Falha de rede mantém o último valor conhecido — erro transitório não
  apaga o que o visitante já estava vendo.
- Payload com status fora do enum é descartado em silêncio.
- O valor inicial vem do server render: a primeira pintura já está
  correta.

O cronômetro e a própria existência da seção também consomem o estado ao
vivo. Sem isso a atualização ficaria incoerente de duas formas: o badge
mudaria para "Votação em andamento" com o cronômetro travado em "Início
da votação em", e uma seção que o servidor renderizou vazia nunca
apareceria quando a votação abrisse.

### Outras mudanças

- Os dois rate limits da validação de eleitor (um por IP, um por
  matrícula) passaram a rodar em paralelo: são independentes e ambos
  sempre avaliados, então a serialização só custava um round trip. As duas
  tentativas continuam sendo contadas mesmo quando uma já estourou — é
  assim que o contador por matrícula registra quem troca de IP.
- `status.ts` e `phases.ts` foram divididos: `status-values.ts` e
  `phase-bounds.ts` guardam o vocabulário e a aritmética de data (puros,
  usáveis no cliente); os módulos originais seguem `server-only` com as
  leituras e reexportam o resto. Sem isso, o badge e o cronômetro ao vivo
  quebrariam o build ao importar um módulo `server-only`.
- `live-state-payload.ts` define a forma do estado ao vivo e sua validação
  **uma vez**, usada pelo servidor ao ler o RPC e pelo cliente ao receber
  o polling.

### Testes

`tests/integration/function-grants.test.ts` (9 testes) verifica a ACL das
funções novas direto no banco: `service_role` executa as duas;
`anon`/`authenticated` recebem `permission denied` na administrativa e
executam a pública; o payload público tem exatamente três campos (trava
contra alguém acrescentar um campo sensível); participação aparece durante
a votação e desaparece fora dela.

Este arquivo existe porque GRANT já quebrou este projeto duas vezes em
produção (migrations 0010 e 0011) e nada disso aparece em typecheck, lint
ou build — só em runtime. Mutation-tested: concedendo `execute` da função
administrativa a `anon`, o teste falha.

Um detalhe que o próprio teste pegou durante a escrita: `set local role`
fora de uma transação é ignorado, então a primeira versão do helper rodava
tudo como superusuário e "passava" sem nunca trocar de papel. Agora cada
chamada abre sua própria transação.

`tests/unit/live-state.test.ts` (11 testes) cobre as duas fronteiras de
dados: a conversão do jsonb (participação nula não virar zero, `numeric`
como string virar número, status desconhecido falhar alto) e a guarda do
payload do polling.

**Não coberto por teste**: o comportamento de timers e Page Visibility do
provider. Testá-lo exigiria jsdom + @testing-library, dependências que o
projeto não tem; a lógica de dados foi extraída para módulos puros
justamente para que a parte testável ficasse testada.

---

## O que mudou na Etapa 1A

### Estratégia de cache

`unstable_cache` com `revalidate: false` + tags. Os dados nunca expiram
por tempo: saem do cache **apenas** quando uma Server Action
administrativa os invalida.

Decisão deliberada de **não** ligar `cacheComponents: true` (que
habilitaria `"use cache"` + `cacheTag`/`cacheLife`): é uma flag top-level
que muda o modelo de renderização de todas as 18 rotas — acesso dinâmico
passa a exigir Suspense/`connection()` — e o app tem CSP com nonce por
requisição, sessões por cookie e uma eleição real em produção. O ganho
seria de API, não de latência. Fica como migração futura isolada.

Premissa verificada na fonte do Next 16.3.5 antes de implementar: o
caminho de leitura do `unstable_cache` só é ignorado com
`fetchCache: 'force-no-store'`, on-demand revalidate ou draft mode —
`dynamic = "force-dynamic"` **não** o desativa. Por isso as páginas
continuam dinâmicas (CSP intacta) enquanto os dados vêm do cache.

### Tags (`lib/cache/tags.ts`)

`public-election`, `election-phases`, `positions`, `candidates`,
`ballot-options`, `published-results`.

### Invalidação

As Server Actions usam `updateTag`, não `revalidateTag`. Em 16.3.5,
`revalidateTag(tag)` com um único argumento emite deprecation warning e
tem semântica eventual; `updateTag` expira imediatamente e dá
read-your-own-writes — o admin vê a alteração na mesma navegação.

| Ação administrativa | Tags invalidadas |
|---|---|
| criar/editar candidato, ativar, desativar, trocar cargo/foto/vídeo | `candidates`, `ballot-options` |
| alterar cronograma | `election-phases`, `public-election` |
| encerrar votação / apurar | `public-election` |
| publicar resultados | `published-results`, `public-election` |
| resolver cargo duplo | `published-results` |
| criar desempate | `public-election` |

### Outras correções

- `getCandidateById`: consulta direta por id (antes carregava todos os
  candidatos e fazia `.find()` em memória)
- `trackPageView`: movido para `after()` — sai do caminho crítico e não
  corre mais o risco de ser cortado pelo fim da invocação serverless
- spinner global público substituído por skeletons de layout estável em
  `/candidatos` e `/cargos`

### O que continua sem cache (por segurança)

`compute_election_status` (status autoritativo, depende de `now()`),
participação, sessões de voto, validação de eleitor, votos, e toda
leitura administrativa sensível.

---

## Testes

`tests/unit/cache-invalidation.test.ts` verifica que cada mutação
administrativa invalida as tags corretas — a rede de segurança contra
"alguém adiciona uma mutação e esquece de invalidar", que com
`revalidate: false` deixaria o dado velho servido indefinidamente.

A suíte foi **mutation-tested**: removendo uma chamada de invalidação, o
teste falha como esperado.

Suíte completa após a Etapa 1A: 58 testes passando (50 anteriores + 8
novos), lint e `tsc --noEmit` limpos, build de produção OK.

---

## Limitação conhecida

Com `revalidate: false`, o cache só é invalidado por Server Actions do
app. **Alterações feitas direto no banco** (SQL Editor do Supabase,
`psql`) não invalidam nada — a home/candidatos continuariam servindo o
valor antigo. Vale para candidatos, cargos, cronograma e a linha da
eleição.

**Mitigação implementada**: o painel (`/admin/dashboard` → "Cache do
site") tem o botão "Atualizar dados do site", que chama
`invalidateAllCachesAction` — ela itera sobre `CACHE_TAGS` e invalida
todas. Iterar, em vez de listar as tags à mão, garante que uma tag criada
no futuro já entre no botão; o teste compara o conjunto invalidado com
`Object.values(CACHE_TAGS)` e quebra se alguma ficar de fora (verificado
por mutation test). A ação é registrada em `admin_logs` como
`CACHE_INVALIDATED` e não toca em nada autoritativo — status, votos,
sessões e validação de eleitor nunca foram cacheados.

---

## Próximas etapas

- **2**: observabilidade (Web Vitals, Speed Insights, `/admin/performance`,
  retenção de 30 dias)
- **3**: fluxo crítico (consolidação da validação do eleitor, candidato +
  cargos transacional) — só mediante aprovação explícita

### Decisões já tomadas para a Etapa 2

- **p75 com amostra pequena**: abaixo de **30 amostras** no recorte, a
  página mostra "amostra insuficiente" em vez de um percentil que não
  significa nada.
- **Métricas de backend**: coletadas em **100%** das requisições, via
  `after()` — fora do caminho crítico, então amostrar não compraria nada.
- **`device_class`**: só `mobile` e `desktop`. Sem `tablet` (volume
  esperado não justifica um terceiro recorte).
