import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { compareCandidateResults } from "@/lib/election/display-order";

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
