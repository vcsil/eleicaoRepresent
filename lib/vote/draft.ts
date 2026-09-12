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

export const BALLOT_DRAFT_STORAGE_KEY = "eleicao_ballot_draft_v1";
