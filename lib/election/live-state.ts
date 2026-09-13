import "server-only";
import { createAnonClient } from "@/lib/supabase/server";
import { isVotingOpen } from "@/lib/election/status-values";
import { isElectionStatus, type LiveState } from "@/lib/election/live-state-payload";

export type { LiveState } from "@/lib/election/live-state-payload";

/**
 * NUNCA cacheado: depende de now() do Postgres. Um round trip traz status
 * e participação juntos — antes eram duas chamadas, a segunda serial
 * porque dependia do status para saber se valia a pena.
 */
export async function getLiveElectionState(electionId: string): Promise<LiveState> {
  const supabase = createAnonClient();
  const { data, error } = await supabase.rpc("get_live_election_state", {
    p_election_id: electionId,
  });
  if (error) throw error;

  const payload = (data ?? {}) as {
    status?: unknown;
    participation?: unknown;
    server_time?: unknown;
    active_election_id?: unknown;
  };

  if (!isElectionStatus(payload.status)) {
    throw new Error("get_live_election_state returned an unknown status");
  }

  const participation =
    payload.participation === null || payload.participation === undefined
      ? null
      : Number(payload.participation);

  return {
    status: payload.status,
    participation,
    serverTime:
      typeof payload.server_time === "string" ? payload.server_time : new Date().toISOString(),
    votingOpen: isVotingOpen(payload.status),
    activeElectionId:
      typeof payload.active_election_id === "string" ? payload.active_election_id : null,
  };
}
