import "server-only";
import { createAnonClient } from "@/lib/supabase/server";

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

export async function getActivePositions(): Promise<Position[]> {
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
