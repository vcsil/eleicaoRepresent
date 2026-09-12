import "server-only";
import { unstable_cache } from "next/cache";
import { createAnonClient } from "@/lib/supabase/server";
import { CACHE_TAGS } from "@/lib/cache/tags";

/** Espelha o enum retornado por compute_election_status() no Postgres. */
export const ELECTION_STATUSES = [
  "nao_iniciada",
  "candidaturas_abertas",
  "candidaturas_encerradas",
  "candidatos_divulgados",
  "apresentacao",
  "aguardando_votacao",
  "votacao_em_andamento",
  "votacao_encerrada",
  "em_apuracao",
  "aguardando_divulgacao",
  "resultado_disponivel",
  "desempate_necessario",
  "votacao_desempate",
] as const;

export type ElectionStatus = (typeof ELECTION_STATUSES)[number];

export const ELECTION_STATUS_LABELS: Record<ElectionStatus, string> = {
  nao_iniciada: "Eleição ainda não iniciada",
  candidaturas_abertas: "Candidaturas abertas",
  candidaturas_encerradas: "Candidaturas encerradas",
  candidatos_divulgados: "Candidatos divulgados",
  apresentacao: "Apresentação dos candidatos",
  aguardando_votacao: "Aguardando votação",
  votacao_em_andamento: "Votação em andamento",
  votacao_encerrada: "Votação encerrada",
  em_apuracao: "Em apuração",
  aguardando_divulgacao: "Aguardando divulgação",
  resultado_disponivel: "Resultado disponível",
  desempate_necessario: "Desempate necessário",
  votacao_desempate: "Votação de desempate",
};

export type Election = {
  id: string;
  type: "general" | "runoff";
  parent_election_id: string | null;
  name: string;
  runoff_position_id: string | null;
  voting_closed_manually_at: string | null;
  results_computed_at: string | null;
  results_published_at: string | null;
};

async function fetchMainElection(): Promise<Election | null> {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from("elections")
    .select(
      "id, type, parent_election_id, name, runoff_position_id, voting_closed_manually_at, results_computed_at, results_published_at",
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
 */
export async function getElectionStatus(electionId: string): Promise<ElectionStatus> {
  const supabase = createAnonClient();
  const { data, error } = await supabase.rpc("compute_election_status", {
    p_election_id: electionId,
  });
  if (error) throw error;
  return data as ElectionStatus;
}

export const VOTING_STATUSES: ElectionStatus[] = ["votacao_em_andamento", "votacao_desempate"];

export function isVotingOpen(status: ElectionStatus): boolean {
  return VOTING_STATUSES.includes(status);
}
