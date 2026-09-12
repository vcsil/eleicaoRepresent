import "server-only";
import { unstable_cache } from "next/cache";
import { createAnonClient } from "@/lib/supabase/server";
import { CACHE_TAGS } from "@/lib/cache/tags";

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
async function fetchPublishedResults(electionId: string): Promise<ResultSnapshotRow[]> {
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

/**
 * Resultados publicados são imutáveis na prática: só mudam se o admin
 * publicar, recalcular ou resolver uma pendência de composição — todas
 * essas actions invalidam `published-results`. Antes da publicação a RLS
 * já devolve vazio, e esse vazio também é invalidado na publicação.
 */
export const getPublishedResults = unstable_cache(fetchPublishedResults, ["published-results"], {
  tags: [CACHE_TAGS.publishedResults],
  revalidate: false,
});
