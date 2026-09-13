import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type PendingTie = {
  position_id: string;
  position_name: string;
  candidates: { id: string; name: string; votes_count: number }[];
};

/**
 * Empates que ainda NÃO têm votação de desempate criada.
 *
 * Filtrar aqui é o que impede o painel de continuar oferecendo "criar
 * desempate" para um cargo que já tem um em andamento — antes o formulário
 * seguia aparecendo, e só o banco barrava a duplicação.
 */
export async function getPendingTies(electionId: string): Promise<PendingTie[]> {
  const supabase = createServiceClient();
  const [{ data, error }, { data: openRunoffs, error: runoffError }] = await Promise.all([
    supabase
      .from("result_snapshots")
      .select("position_id, position_name, candidate_id, candidate_name, votes_count")
      .eq("election_id", electionId)
      .eq("tie_break_needed", true),
    supabase
      .from("runoff_positions")
      .select("position_id")
      .eq("parent_election_id", electionId)
      .is("resolved_at", null),
  ]);

  if (error) throw error;
  if (runoffError) throw runoffError;

  const jaTemDesempate = new Set((openRunoffs ?? []).map((r) => r.position_id as string));

  const byPosition = new Map<string, PendingTie>();
  for (const row of data ?? []) {
    if (!row.candidate_id) continue;
    if (jaTemDesempate.has(row.position_id)) continue;
    const entry: PendingTie = byPosition.get(row.position_id) ?? {
      position_id: row.position_id,
      position_name: row.position_name,
      candidates: [],
    };
    entry.candidates.push({
      id: row.candidate_id,
      name: row.candidate_name ?? "Candidato",
      votes_count: row.votes_count,
    });
    byPosition.set(row.position_id, entry);
  }

  return Array.from(byPosition.values());
}

export type PendingDualWinnerDecision = {
  id: string;
  candidate_id: string;
  candidate_name: string;
  position_id_a: string;
  position_name_a: string;
  position_id_b: string;
  position_name_b: string;
};

export async function getPendingDualWinnerDecisions(
  electionId: string,
): Promise<PendingDualWinnerDecision[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("position_dual_winner_decisions")
    .select(
      `id, candidate_id,
       candidates ( full_name ),
       position_a:positions!position_dual_winner_decisions_position_id_a_fkey ( id, name ),
       position_b:positions!position_dual_winner_decisions_position_id_b_fkey ( id, name )`,
    )
    .eq("election_id", electionId)
    .eq("status", "pending");

  if (error) throw error;

  type Row = {
    id: string;
    candidate_id: string;
    candidates: { full_name: string } | null;
    position_a: { id: string; name: string } | null;
    position_b: { id: string; name: string } | null;
  };

  return ((data ?? []) as unknown as Row[])
    .filter((row) => row.position_a && row.position_b)
    .map((row) => ({
      id: row.id,
      candidate_id: row.candidate_id,
      candidate_name: row.candidates?.full_name ?? "Candidato",
      position_id_a: row.position_a!.id,
      position_name_a: row.position_a!.name,
      position_id_b: row.position_b!.id,
      position_name_b: row.position_b!.name,
    }));
}

/** Onde cada desempate está no ciclo, para o painel não deixar dúvida. */
export type RunoffStage =
  | "agendado"
  | "votacao_aberta"
  | "aguardando_apuracao"
  | "apurado"
  | "novo_empate"
  | "concluido";

export const RUNOFF_STAGE_LABELS: Record<RunoffStage, string> = {
  agendado: "Agendado",
  votacao_aberta: "Votação aberta",
  aguardando_apuracao: "Encerrado — aguardando apuração",
  apurado: "Apurado — aguardando publicação",
  novo_empate: "Novo empate — precisa de outra rodada",
  concluido: "Concluído — empate resolvido",
};

export type RunoffElection = {
  id: string;
  name: string;
  runoff_reason: string | null;
  results_computed_at: string | null;
  results_published_at: string | null;
  created_at: string;
  stage: RunoffStage;
  positions: string[];
};

export async function getRunoffs(electionId: string): Promise<RunoffElection[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("elections")
    .select("id, name, runoff_reason, results_computed_at, results_published_at, created_at")
    .eq("parent_election_id", electionId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  const runoffs = data ?? [];
  if (runoffs.length === 0) return [];

  const ids = runoffs.map((r) => r.id as string);

  const [statuses, { data: ties }, { data: positions }] = await Promise.all([
    // O status é autoritativo e depende de now(): uma chamada por desempate,
    // em paralelo. São poucos por eleição.
    Promise.all(
      ids.map(async (id) => {
        const { data: status } = await supabase.rpc("compute_election_status", {
          p_election_id: id,
        });
        return [id, status as string] as const;
      }),
    ),
    supabase
      .from("result_snapshots")
      .select("election_id")
      .in("election_id", ids)
      .eq("tie_break_needed", true),
    supabase
      .from("runoff_positions")
      .select("runoff_election_id, positions ( name )")
      .in("runoff_election_id", ids),
  ]);

  const statusById = new Map(statuses);
  const comNovoEmpate = new Set((ties ?? []).map((t) => t.election_id as string));
  const nomesPorRunoff = new Map<string, string[]>();
  for (const row of (positions ?? []) as unknown as {
    runoff_election_id: string;
    positions: { name: string } | null;
  }[]) {
    if (!row.positions) continue;
    const list = nomesPorRunoff.get(row.runoff_election_id) ?? [];
    list.push(row.positions.name);
    nomesPorRunoff.set(row.runoff_election_id, list);
  }

  return runoffs.map((runoff) => {
    const id = runoff.id as string;
    let stage: RunoffStage;
    if (runoff.results_published_at) stage = "concluido";
    else if (comNovoEmpate.has(id)) stage = "novo_empate";
    else if (runoff.results_computed_at) stage = "apurado";
    else if (statusById.get(id) === "votacao_desempate") stage = "votacao_aberta";
    else if (statusById.get(id) === "aguardando_votacao") stage = "agendado";
    else stage = "aguardando_apuracao";

    return { ...runoff, stage, positions: nomesPorRunoff.get(id) ?? [] } as RunoffElection;
  });
}
