import "server-only";
import { unstable_cache } from "next/cache";
import { createAnonClient } from "@/lib/supabase/server";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { compareCandidatesByName } from "@/lib/election/display-order";

export type CandidateWithPositions = {
  id: string;
  full_name: string;
  photo_path: string | null;
  tagline: string | null;
  presentation: string | null;
  proposals: string | null;
  video_url: string | null;
  display_order: number;
  positions: { id: string; slug: string; name: string; display_order: number }[];
};

async function fetchActiveCandidates(): Promise<CandidateWithPositions[]> {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from("candidates")
    .select(
      `id, full_name, photo_path, tagline, presentation, proposals, video_url, display_order,
       candidate_positions ( positions ( id, slug, name, display_order ) )`,
    )
    .eq("active", true);

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
    candidate_positions: {
      positions: { id: string; slug: string; name: string; display_order: number } | null;
    }[] | null;
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
      .filter(
        (p): p is { id: string; slug: string; name: string; display_order: number } => Boolean(p),
      )
      .sort((a, b) => a.display_order - b.display_order),
  })).sort(compareCandidatesByName);
}

/**
 * Candidatos só mudam por ação administrativa: cacheado sem expiração
 * por tempo, invalidado pelas tags `candidates` e `ballot-options`
 * (a urna deriva suas opções desta mesma leitura).
 */
export const getActiveCandidates = unstable_cache(fetchActiveCandidates, ["active-candidates"], {
  tags: [CACHE_TAGS.candidates, CACHE_TAGS.ballotOptions],
  revalidate: false,
});
