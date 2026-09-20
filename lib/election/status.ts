import "server-only";
import { unstable_cache } from "next/cache";
import { createAnonClient } from "@/lib/supabase/server";
import { CACHE_TAGS } from "@/lib/cache/tags";
import type { ElectionStatus } from "@/lib/election/status-values";

// Reexportados para que os consumidores existentes continuem importando
// daqui; o vocabulário vive em status-values.ts porque os componentes ao
// vivo precisam dele no cliente.
export {
  ELECTION_STATUSES,
  ELECTION_STATUS_LABELS,
  VOTING_STATUSES,
  isVotingOpen,
  type ElectionStatus,
} from "@/lib/election/status-values";

export type Election = {
  id: string;
  type: "general" | "runoff";
  parent_election_id: string | null;
  name: string;
  runoff_position_id: string | null;
  /** Nulo até o administrador liberar a votação (migration 0020). */
  voting_released_at: string | null;
  voting_closed_manually_at: string | null;
  results_computed_at: string | null;
  results_published_at: string | null;
};

async function fetchMainElection(): Promise<Election | null> {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from("elections")
    .select(
      "id, type, parent_election_id, name, runoff_position_id, voting_released_at, voting_closed_manually_at, results_computed_at, results_published_at",
    )
    .eq("type", "general")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as Election | null;
}

/**
 * Retorna a eleição geral principal (assume-se uma única eleição geral
 * ativa por vez, conforme seção 82 do documento técnico).
 *
 * Cacheado: a linha só muda por ação administrativa (encerrar votação,
 * apurar, publicar), e todas essas actions invalidam `public-election`.
 */
export const getMainElection = unstable_cache(fetchMainElection, ["main-election"], {
  tags: [CACHE_TAGS.publicElection],
  revalidate: false,
});

/**
 * Status autoritativo, sempre calculado no servidor (nunca no cliente) e
 * NUNCA cacheado: depende de now() do Postgres e é o que autoriza (ou
 * nega) o acesso à urna.
 *
 * Para a home e o painel, prefira getLiveElectionState /
 * getAdminDashboardMetrics: trazem o status junto com a participação em um
 * único round trip.
 */
export async function getElectionStatus(electionId: string): Promise<ElectionStatus> {
  const supabase = createAnonClient();
  const { data, error } = await supabase.rpc("compute_election_status", {
    p_election_id: electionId,
  });
  if (error) throw error;
  return data as ElectionStatus;
}
