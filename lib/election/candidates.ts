import "server-only";
import { createAnonClient } from "@/lib/supabase/server";

export type CandidateWithPositions = {
  id: string;
  full_name: string;
  photo_path: string | null;
  tagline: string | null;
  presentation: string | null;
  proposals: string | null;
  video_url: string | null;
  display_order: number;
  positions: { id: string; slug: string; name: string }[];
};

export async function getActiveCandidates(): Promise<CandidateWithPositions[]> {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from("candidates")
    .select(
      `id, full_name, photo_path, tagline, presentation, proposals, video_url, display_order,
       candidate_positions ( positions ( id, slug, name ) )`,
    )
    .eq("active", true)
    .order("display_order", { ascending: true });

  if (error) throw error;

  type Row = {
    id: string;
    full_name: string;
    photo_path: string | null;
    tagline: string | null;
    presentation: string | null;
    proposals: string | null;
    video_url: string | null;
    display_order: number;
    candidate_positions: { positions: { id: string; slug: string; name: string } | null }[] | null;
  };

  return ((data ?? []) as unknown as Row[]).map((row) => ({
    id: row.id,
    full_name: row.full_name,
    photo_path: row.photo_path,
    tagline: row.tagline,
    presentation: row.presentation,
    proposals: row.proposals,
    video_url: row.video_url,
    display_order: row.display_order,
    positions: (row.candidate_positions ?? [])
      .map((cp) => cp.positions)
      .filter((p): p is { id: string; slug: string; name: string } => Boolean(p)),
  }));
}

export function candidatePhotoUrl(photoPath: string | null): string | null {
  if (!photoPath) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/candidate-photos/${photoPath}`;
}
