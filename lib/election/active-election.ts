import "server-only";
import { createAnonClient } from "@/lib/supabase/server";

export type ActiveElectionPosition = {
  position_id: string;
  votes_per_voter: number;
  vacancies: number;
};

export type ActiveElection = {
  electionId: string;
  type: "general" | "runoff";
  parentElectionId: string | null;
  positions: ActiveElectionPosition[];
};

/**
 * Qual eleição está EFETIVAMENTE aberta para votar.
 *
 * Antes, /votar resolvia sempre a eleição geral (`getMainElection`), o que
 * tornava uma votação de desempate inalcançável pelo site: com empate
 * pendente o status da geral é `desempate_necessario`, e a página
 * respondia "a votação não está disponível".
 *
 * A decisão é do Postgres (`get_current_voting_election`), a partir do
 * status autoritativo — nunca "pega o desempate mais recente". Se por
 * algum caminho houver duas votações abertas, a função falha alto em vez
 * de escolher por conta própria.
 *
 * NUNCA cacheado: depende de now() e é o que decide se existe urna.
 */
export async function getCurrentVotingElection(): Promise<ActiveElection | null> {
  const supabase = createAnonClient();
  const { data, error } = await supabase.rpc("get_current_voting_election");
  if (error) throw error;
  if (!data) return null;

  const payload = data as {
    election_id?: unknown;
    type?: unknown;
    parent_election_id?: unknown;
    positions?: unknown;
  };

  if (typeof payload.election_id !== "string") return null;
  if (payload.type !== "general" && payload.type !== "runoff") return null;

  return {
    electionId: payload.election_id,
    type: payload.type,
    parentElectionId:
      typeof payload.parent_election_id === "string" ? payload.parent_election_id : null,
    positions: Array.isArray(payload.positions)
      ? (payload.positions as ActiveElectionPosition[])
      : [],
  };
}
