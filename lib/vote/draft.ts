// Sem "server-only": usado tanto no wizard (client) quanto na Server Action
// de envio. É só a forma de rascunho local — a fonte da verdade da votação
// continua sendo a validação em cast_ballot() no Postgres.

export const NULL_OPTION_KEY = "null";

/** positionId -> (candidateId | "null") -> quantidade */
export type BallotDraft = Record<string, Record<string, number>>;

export function getPositionTotal(draft: BallotDraft, positionId: string): number {
  const allocations = draft[positionId] ?? {};
  return Object.values(allocations).reduce((sum, qty) => sum + qty, 0);
}

export type BallotSubmitPayload = {
  positions: {
    position_id: string;
    allocations: { candidate_id: string | null; is_null_vote: boolean; quantity: number }[];
  }[];
};

export function draftToPayload(draft: BallotDraft): BallotSubmitPayload {
  return {
    positions: Object.entries(draft).map(([positionId, allocations]) => ({
      position_id: positionId,
      allocations: Object.entries(allocations)
        .filter(([, quantity]) => quantity > 0)
        .map(([key, quantity]) => ({
          candidate_id: key === NULL_OPTION_KEY ? null : key,
          is_null_vote: key === NULL_OPTION_KEY,
          quantity,
        })),
    })),
  };
}

/**
 * Prefixo das chaves de rascunho no sessionStorage. A chave real inclui um
 * identificador da sessão de voto (ver deriveDraftSessionKey): em
 * dispositivo compartilhado, um eleitor que abandona a urna não pode
 * deixar sua distribuição visível — nem enviável — para o próximo.
 */
export const BALLOT_DRAFT_KEY_PREFIX = "eleicao_ballot_draft_v1";

export function buildDraftStorageKey(sessionKey: string): string {
  return `${BALLOT_DRAFT_KEY_PREFIX}:${sessionKey}`;
}

/**
 * Apaga rascunhos de QUALQUER outra sessão.
 *
 * A chave por sessão sozinha já impede o próximo eleitor de herdar a
 * distribuição, mas o dado do eleitor anterior continuaria no dispositivo
 * até a aba fechar. Apagar é o que efetivamente o remove — e também
 * recolhe a chave fixa antiga (`eleicao_ballot_draft_v1`, sem sufixo), que
 * casa com o mesmo prefixo.
 */
export function pruneOtherDrafts(storage: Storage, currentKey: string): void {
  const staleKeys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(BALLOT_DRAFT_KEY_PREFIX) && key !== currentKey) {
      staleKeys.push(key);
    }
  }
  for (const key of staleKeys) {
    storage.removeItem(key);
  }
}
