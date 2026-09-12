import "server-only";
import { createAnonClient } from "@/lib/supabase/server";

export type ResultSnapshotRow = {
  position_id: string;
  position_name: string;
  candidate_id: string | null;
  candidate_name: string | null;
  candidate_photo_path: string | null;
  votes_count: number;
  rank: number | null;
  elected: boolean;
  seat_label: string | null;
};

/**
 * Lê os resultados via RLS pública (seção 51) — a policy de
 * result_snapshots só libera linhas de eleições já publicadas, então esta
 * consulta naturalmente retorna vazio antes da divulgação. Nome/foto do
 * candidato e nome do cargo são denormalizados na própria linha (não
 * dependem das policies de candidates/positions, que só liberam registros
 * ativos — seção 51 exige mostrar o resultado histórico mesmo que um
 * candidato ou cargo seja desativado depois).
 */
export async function getPublishedResults(electionId: string): Promise<ResultSnapshotRow[]> {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from("result_snapshots")
    .select(
      "position_id, position_name, candidate_id, candidate_name, candidate_photo_path, votes_count, rank, elected, seat_label",
    )
    .eq("election_id", electionId)
    .order("rank", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return (data ?? []) as ResultSnapshotRow[];
}
