/**
 * Tags do Data Cache do Next.js.
 *
 * Estratégia (ver docs/PERFORMANCE_V2.md): os leitores de dados estáveis
 * usam `unstable_cache` com `revalidate: false` — ou seja, nunca expiram
 * por tempo, só por invalidação explícita. Toda Server Action
 * administrativa que altera esses dados chama `updateTag(...)`, que
 * expira imediatamente e dá read-your-own-writes (o admin vê a alteração
 * na mesma navegação).
 *
 * Nunca cachear: status autoritativo da eleição (depende de now()),
 * participação, sessões, votos, dados administrativos sensíveis.
 */
export const CACHE_TAGS = {
  /** Linha da eleição principal (nome, flags de encerramento/apuração/publicação). */
  publicElection: "public-election",
  /** Fases do cronograma (datas/horas configuradas pelo admin). */
  electionPhases: "election-phases",
  /** Cargos ativos. */
  positions: "positions",
  /** Candidatos ativos e seus cargos. */
  candidates: "candidates",
  /** Opções da urna (derivadas de cargos + candidatos). */
  ballotOptions: "ballot-options",
  /** Snapshots de resultado já publicados. */
  publishedResults: "published-results",
} as const;

export type CacheTag = (typeof CACHE_TAGS)[keyof typeof CACHE_TAGS];
