import "server-only";
import { createAnonClient } from "@/lib/supabase/server";

export type ResultSnapshotRow = {
  position_id: string;
  candidate_id: string | null;
  votes_count: number;
  rank: number | null;
  elected: boolean;
  seat_label: string | null;
};

/**
 * Lê os resultados via RLS pública (seção 51) — a policy de
 * result_snapshots só libera linhas de eleições já publicadas, então esta
 * consulta naturalmente retorna vazio antes da divulgação.
 */
export async function getPublishedResults(electionId: string): Promise<ResultSnapshotRow[]> {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from("result_snapshots")
    .select("position_id, candidate_id, votes_count, rank, elected, seat_label")
    .eq("election_id", electionId)
    .order("rank", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return (data ?? []) as ResultSnapshotRow[];
}
