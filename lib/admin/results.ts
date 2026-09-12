import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type AdminResultRow = {
  position_id: string;
  position_name: string;
  candidate_id: string | null;
  candidate_name: string | null;
  votes_count: number;
  rank: number | null;
  elected: boolean;
  tie_break_needed: boolean;
  seat_label: string | null;
};

export async function getInternalResults(electionId: string): Promise<AdminResultRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("result_snapshots")
    .select(
      "position_id, position_name, candidate_id, candidate_name, votes_count, rank, elected, tie_break_needed, seat_label",
    )
    .eq("election_id", electionId)
    .order("position_name", { ascending: true })
    .order("rank", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data ?? [];
}
