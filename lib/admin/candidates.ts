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

const CANDIDATE_COLUMNS = `id, full_name, photo_path, tagline, presentation, proposals, video_url, active, display_order,
   candidate_positions ( position_id )`;

type CandidateRow = Omit<AdminCandidate, "position_ids"> & {
  candidate_positions: { position_id: string }[] | null;
};

function toAdminCandidate(row: CandidateRow): AdminCandidate {
  const { candidate_positions, ...candidate } = row;
  return {
    ...candidate,
    position_ids: (candidate_positions ?? []).map((cp) => cp.position_id),
  };
}

export async function listAllCandidates(): Promise<AdminCandidate[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("candidates")
    .select(CANDIDATE_COLUMNS)
    .order("display_order", { ascending: true });

  if (error) throw error;
  return ((data ?? []) as unknown as CandidateRow[]).map(toAdminCandidate);
}

/** Busca direta pelo id — não carrega a lista inteira para editar um candidato. */
export async function getCandidateById(id: string): Promise<AdminCandidate | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("candidates")
    .select(CANDIDATE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data ? toAdminCandidate(data as unknown as CandidateRow) : null;
}
