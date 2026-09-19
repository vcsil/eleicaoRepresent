import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { compareCandidateResults } from "@/lib/election/display-order";
import { computeSeatGaps, type SeatGap } from "@/lib/election/seat-gaps";

export type AdminResultRow = {
  position_id: string;
  position_name: string;
  candidate_id: string | null;
  candidate_name: string | null;
  votes_count: number;
  rank: number | null;
  elected: boolean;
  unopposed: boolean;
  tie_break_needed: boolean;
  seat_label: string | null;
  /**
   * Vagas do cargo, anexadas à linha para a tela calcular quantas ficaram
   * sem preenchimento. Nula quando o cargo não existe mais — um resultado
   * histórico continua legível, apenas sem essa conta.
   */
  vacancies: number | null;
};

export async function getInternalResults(electionId: string): Promise<AdminResultRow[]> {
  const supabase = createServiceClient();
  const [{ data, error }, { data: positions, error: positionsError }] = await Promise.all([
    supabase
      .from("result_snapshots")
      .select(
        "position_id, position_name, candidate_id, candidate_name, votes_count, rank, elected, unopposed, tie_break_needed, seat_label",
      )
      .eq("election_id", electionId),
    supabase.from("positions").select("id, display_order, vacancies"),
  ]);

  if (error) throw error;
  if (positionsError) throw positionsError;

  const positionRows = (positions ?? []) as {
    id: string;
    display_order: number;
    vacancies: number;
  }[];
  const positionOrder = new Map<string, number>(
    positionRows.map((position) => [position.id, position.display_order]),
  );
  const vacanciesByPosition = new Map<string, number>(
    positionRows.map((position) => [position.id, position.vacancies]),
  );

  return ((data ?? []) as Omit<AdminResultRow, "vacancies">[])
    .map((row) => ({ ...row, vacancies: vacanciesByPosition.get(row.position_id) ?? null }))
    .sort((a, b) => {
      const byPosition =
        (positionOrder.get(a.position_id) ?? Number.MAX_SAFE_INTEGER) -
        (positionOrder.get(b.position_id) ?? Number.MAX_SAFE_INTEGER);
      if (byPosition !== 0) return byPosition;
      if (a.candidate_id === null) return 1;
      if (b.candidate_id === null) return -1;
      return compareCandidateResults(a, b);
    });
}

export type AdminPositionResult = {
  positionId: string;
  positionName: string;
  vacancies: number | null;
  rows: AdminResultRow[];
  electedCount: number;
  /** Vagas sem ocupante, já separadas por CAUSA. Só entram causas com 1+. */
  seatGaps: SeatGap[];
};

/**
 * Resultados internos agrupados por cargo, incluindo os cargos que NÃO
 * têm snapshot nenhum.
 *
 * Cargo sem candidatura não gera linha em `result_snapshots` (a apuração
 * não tem o que registrar). Agrupar só os snapshots, como a tela fazia,
 * fazia esse cargo sumir inteiro da revisão administrativa — justamente o
 * caso que mais precisa de conferência antes de publicar.
 *
 * A causa de cada vaga vazia é apurada, nunca inferida da subtração:
 * `vagas − eleitos` diz QUANTAS faltam, não POR QUÊ. Dois candidatos
 * empatados para uma vaga produzem a mesma diferença de um cargo sem
 * candidato algum, e anunciar "sem candidato" nesse caso seria informação
 * errada num documento eleitoral.
 */
export async function getInternalResultsByPosition(
  electionId: string,
): Promise<AdminPositionResult[]> {
  const supabase = createServiceClient();

  const [rows, positionsResult, reassignmentsResult, runoffResult] = await Promise.all([
    getInternalResults(electionId),
    supabase
      .from("positions")
      .select("id, name, vacancies, display_order")
      .eq("active", true)
      .order("display_order", { ascending: true }),
    supabase
      .from("seat_reassignments")
      .select("position_id, promoted_candidate_id")
      .eq("election_id", electionId),
    supabase
      .from("runoff_positions")
      .select("position_id, vacancies_in_dispute, resolved_at")
      .eq("parent_election_id", electionId),
  ]);

  if (positionsResult.error) throw positionsResult.error;
  if (reassignmentsResult.error) throw reassignmentsResult.error;
  if (runoffResult.error) throw runoffResult.error;

  const rowsByPosition = new Map<string, AdminResultRow[]>();
  for (const row of rows) {
    const list = rowsByPosition.get(row.position_id) ?? [];
    list.push(row);
    rowsByPosition.set(row.position_id, list);
  }

  // Vagas esvaziadas por decisão de cargo duplo sem ninguém para promover.
  const vagasPorCargoDuplo = new Map<string, number>();
  for (const row of (reassignmentsResult.data ?? []) as {
    position_id: string;
    promoted_candidate_id: string | null;
  }[]) {
    if (row.promoted_candidate_id !== null) continue;
    vagasPorCargoDuplo.set(row.position_id, (vagasPorCargoDuplo.get(row.position_id) ?? 0) + 1);
  }

  // Vagas em desempate ainda não resolvido.
  const vagasEmDesempate = new Map<string, number>();
  for (const row of (runoffResult.data ?? []) as {
    position_id: string;
    vacancies_in_dispute: number;
    resolved_at: string | null;
  }[]) {
    if (row.resolved_at !== null) continue;
    vagasEmDesempate.set(
      row.position_id,
      (vagasEmDesempate.get(row.position_id) ?? 0) + row.vacancies_in_dispute,
    );
  }

  const positions = (positionsResult.data ?? []) as {
    id: string;
    name: string;
    vacancies: number;
  }[];

  // Cargos desativados depois da apuração ainda aparecem, pelo snapshot:
  // um resultado histórico não pode sumir da revisão.
  const conhecidos = new Set(positions.map((p) => p.id));
  const extras = Array.from(rowsByPosition.entries())
    .filter(([id]) => !conhecidos.has(id))
    .map(([id, lista]) => ({
      id,
      name: lista[0]?.position_name ?? "Cargo removido",
      vacancies: lista[0]?.vacancies ?? 0,
    }));

  return [...positions, ...extras].map((position) => {
    const lista = rowsByPosition.get(position.id) ?? [];
    const electedCount = lista.filter((row) => row.elected).length;
    const vacancies = position.vacancies ?? null;

    const seatGaps = computeSeatGaps({
      vacancies,
      electedCount,
      vacatedByDualWinner: vagasPorCargoDuplo.get(position.id) ?? 0,
      seatsInRunoff: vagasEmDesempate.get(position.id) ?? 0,
      hasPendingTie: lista.some((row) => row.tie_break_needed),
    });

    return {
      positionId: position.id,
      positionName: position.name,
      vacancies,
      rows: lista,
      electedCount,
      seatGaps,
    };
  });
}
