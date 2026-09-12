import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type AdminCandidate = {
  id: string;
  full_name: string;
  photo_path: string | null;
  tagline: string | null;
  presentation: string | null;
  proposals: string | null;
  video_url: string | null;
  active: boolean;
  display_order: number;
  position_ids: string[];
};

export async function listAllCandidates(): Promise<AdminCandidate[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("candidates")
    .select(
      `id, full_name, photo_path, tagline, presentation, proposals, video_url, active, display_order,
       candidate_positions ( position_id )`,
    )
    .order("display_order", { ascending: true });

  if (error) throw error;

  type Row = Omit<AdminCandidate, "position_ids"> & {
    candidate_positions: { position_id: string }[] | null;
  };

  return ((data ?? []) as unknown as Row[]).map((row) => ({
    ...row,
    position_ids: (row.candidate_positions ?? []).map((cp) => cp.position_id),
  }));
}

export async function getCandidateById(id: string): Promise<AdminCandidate | null> {
  const candidates = await listAllCandidates();
  return candidates.find((c) => c.id === id) ?? null;
}
