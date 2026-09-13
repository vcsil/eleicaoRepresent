# Performance V2 — segundo deploy

Documento vivo desta iteração de performance. Registra baseline, o que
mudou, o que foi medido e o que ficou pendente.

Status: **Etapa 1A concluída**. Etapas 1B, 2 e 3 pendentes.

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

- **1B**: migration `0012` com `get_admin_dashboard_metrics()` e
  `get_live_election_state()`; `LiveElectionState` com polling de 30s +
  Page Visibility; paralelização dos rate limits da validação do eleitor
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
