import "server-only";
import { createAnonClient } from "@/lib/supabase/server";

/**
 * Único indicador público de andamento durante a votação (seção 47) — o
 * agregado é calculado inteiramente no Postgres, nunca a partir de linhas
 * de voters/audit_vote_links expostas ao cliente.
 */
export async function getParticipationPercentage(electionId: string): Promise<number> {
  const supabase = createAnonClient();
  const { data, error } = await supabase.rpc("get_participation_percentage", {
    p_election_id: electionId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}
