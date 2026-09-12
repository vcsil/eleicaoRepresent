import "server-only";
import { unstable_cache } from "next/cache";
import { createAnonClient } from "@/lib/supabase/server";
import { CACHE_TAGS } from "@/lib/cache/tags";

export type Position = {
  id: string;
  slug: string;
  name: string;
  vacancies: number;
  votes_per_voter: number;
  seat_labels: string[] | null;
  description: string | null;
  responsibilities: string | null;
  profile: string | null;
  icon: string | null;
  display_order: number;
};

async function fetchActivePositions(): Promise<Position[]> {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from("positions")
    .select(
      "id, slug, name, vacancies, votes_per_voter, seat_labels, description, responsibilities, profile, icon, display_order",
    )
    .eq("active", true)
    .order("display_order", { ascending: true });

  if (error) throw error;
  return (data ?? []) as Position[];
}

/**
 * Cargos mudam raríssimas vezes: cacheado sem expiração por tempo,
 * invalidado apenas por ação administrativa (tag `positions`).
 */
export const getActivePositions = unstable_cache(fetchActivePositions, ["active-positions"], {
  tags: [CACHE_TAGS.positions],
  revalidate: false,
});
