import "server-only";
import { unstable_cache } from "next/cache";
import { createAnonClient } from "@/lib/supabase/server";
import { CACHE_TAGS } from "@/lib/cache/tags";

export type ElectionPhaseKey =
  | "edital"
  | "candidaturas"
  | "divulgacao_candidaturas"
  | "apresentacao"
  | "envio_videos"
  | "votacao"
  | "apuracao"
  | "divulgacao_resultados";

export type ElectionPhase = {
  id: string;
  election_id: string;
  phase_key: ElectionPhaseKey;
  label: string;
  starts_on: string;
  ends_on: string;
  start_time: string;
  end_time: string;
  time_configured: boolean;
  display_order: number;
};

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

// America/Sao_Paulo está fixo em UTC-03:00 desde a extinção do horário de
// verão no Brasil (Decreto 10.166/2019) — por isso um offset fixo é
// suficiente e mais confiável do que truques de conversão via toLocaleString.
const SAO_PAULO_OFFSET = "-03:00";

/** Instante efetivo (data + hora, no fuso oficial) de início/fim de uma fase. */
export function getPhaseBounds(phase: ElectionPhase): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date(`${phase.starts_on}T${phase.start_time}${SAO_PAULO_OFFSET}`);
  const endsAt = new Date(`${phase.ends_on}T${phase.end_time}${SAO_PAULO_OFFSET}`);
  return { startsAt, endsAt };
}

export type PhaseTimelineState = "past" | "current" | "future";

export function getPhaseTimelineState(phase: ElectionPhase, now: Date): PhaseTimelineState {
  const { startsAt, endsAt } = getPhaseBounds(phase);
  if (now < startsAt) return "future";
  if (now > endsAt) return "past";
  return "current";
}
