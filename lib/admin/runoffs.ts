import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type PendingTie = {
  position_id: string;
  position_name: string;
  candidates: { id: string; name: string; votes_count: number }[];
};

export async function getPendingTies(electionId: string): Promise<PendingTie[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("result_snapshots")
    .select("position_id, position_name, candidate_id, candidate_name, votes_count")
    .eq("election_id", electionId)
    .eq("tie_break_needed", true);

  if (error) throw error;

  const byPosition = new Map<string, PendingTie>();
  for (const row of data ?? []) {
    if (!row.candidate_id) continue;
    const entry: PendingTie = byPosition.get(row.position_id) ?? {
      position_id: row.position_id,
      position_name: row.position_name,
      candidates: [],
    };
    entry.candidates.push({
      id: row.candidate_id,
      name: row.candidate_name ?? "Candidato",
      votes_count: row.votes_count,
    });
    byPosition.set(row.position_id, entry);
  }

  return Array.from(byPosition.values());
}

export type PendingDualWinnerDecision = {
  id: string;
  candidate_id: string;
  candidate_name: string;
  position_id_a: string;
  position_name_a: string;
  position_id_b: string;
  position_name_b: string;
};

export async function getPendingDualWinnerDecisions(
  electionId: string,
): Promise<PendingDualWinnerDecision[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("position_dual_winner_decisions")
    .select(
      `id, candidate_id,
       candidates ( full_name ),
       position_a:positions!position_dual_winner_decisions_position_id_a_fkey ( id, name ),
       position_b:positions!position_dual_winner_decisions_position_id_b_fkey ( id, name )`,
    )
    .eq("election_id", electionId)
    .eq("status", "pending");

  if (error) throw error;

  type Row = {
    id: string;
    candidate_id: string;
    candidates: { full_name: string } | null;
    position_a: { id: string; name: string } | null;
    position_b: { id: string; name: string } | null;
  };

  return ((data ?? []) as unknown as Row[])
    .filter((row) => row.position_a && row.position_b)
    .map((row) => ({
      id: row.id,
      candidate_id: row.candidate_id,
      candidate_name: row.candidates?.full_name ?? "Candidato",
      position_id_a: row.position_a!.id,
      position_name_a: row.position_a!.name,
      position_id_b: row.position_b!.id,
      position_name_b: row.position_b!.name,
    }));
}

export type RunoffElection = {
  id: string;
  name: string;
  runoff_reason: string | null;
  results_computed_at: string | null;
  results_published_at: string | null;
  created_at: string;
};

export async function getRunoffs(electionId: string): Promise<RunoffElection[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("elections")
    .select("id, name, runoff_reason, results_computed_at, results_published_at, created_at")
    .eq("parent_election_id", electionId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}
