import "server-only";
import { unstable_cache } from "next/cache";
import { createAnonClient } from "@/lib/supabase/server";
import { CACHE_TAGS } from "@/lib/cache/tags";
import type { ElectionPhase } from "@/lib/election/phase-bounds";

// Reexportados para que os consumidores existentes continuem importando
// daqui; a aritmética de data vive em phase-bounds.ts porque o countdown
// ao vivo precisa dela no cliente.
export {
  getPhaseBounds,
  getPhaseTimelineState,
  type ElectionPhase,
  type ElectionPhaseKey,
  type PhaseTimelineState,
} from "@/lib/election/phase-bounds";

async function fetchElectionPhases(electionId: string): Promise<ElectionPhase[]> {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from("election_phases")
    .select(
      "id, election_id, phase_key, label, starts_on, ends_on, start_time, end_time, time_configured, display_order",
    )
    .eq("election_id", electionId)
    .order("display_order", { ascending: true });

  if (error) throw error;
  return (data ?? []) as ElectionPhase[];
}

/**
 * O cronograma só muda quando o admin salva em /admin/cronograma.
 * O `electionId` entra na chave do cache automaticamente (argumento da
 * função memoizada). O status autoritativo NÃO é cacheado — continua
 * sendo calculado no Postgres a cada request.
 */
export const getElectionPhases = unstable_cache(fetchElectionPhases, ["election-phases"], {
  tags: [CACHE_TAGS.electionPhases],
  revalidate: false,
});
