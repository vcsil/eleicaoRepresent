import "server-only";
import { getActivePositions } from "@/lib/election/positions";
import { getActiveCandidates } from "@/lib/election/candidates";
import { createServiceClient } from "@/lib/supabase/service";
import type { VoteSessionElection } from "@/lib/election/vote-session";
import { compareCandidatesByName } from "@/lib/election/display-order";
import { getContestedPositionIds } from "@/lib/election/composition-freeze";

export type WizardPosition = {
  id: string;
  name: string;
  votes_per_voter: number;
};

export type WizardCandidate = {
  id: string;
  full_name: string;
  photo_path: string | null;
};

export type BallotOptions = {
  positions: WizardPosition[];
  candidatesByPosition: Record<string, WizardCandidate[]>;
};

/**
 * Cédula da eleição geral: os cargos ativos COM DISPUTA e seus candidatos.
 *
 * Cargo cujos candidatos ativos não superam as vagas fica de fora — não há
 * escolha a fazer, e pedir um voto obrigatório ali seria encenação. A lista
 * vem de `contested_position_ids()`, a mesma que `cast_ballot` exige: a
 * cédula não pode trazer um cargo que o envio vai recusar, nem faltar um
 * que ele vai cobrar.
 */
async function getGeneralBallotOptions(): Promise<BallotOptions> {
  const [todasPositions, candidates, contestedIds] = await Promise.all([
    getActivePositions(),
    getActiveCandidates(),
    getContestedPositionIds(),
  ]);

  const contested = new Set(contestedIds);
  const positions = todasPositions.filter((p) => contested.has(p.id));

  const candidatesByPosition: Record<string, WizardCandidate[]> = {};
  for (const position of positions) {
    candidatesByPosition[position.id] = candidates
      .filter((c) => c.positions.some((p) => p.id === position.id))
      .map((c) => ({ id: c.id, full_name: c.full_name, photo_path: c.photo_path }))
      .sort(compareCandidatesByName);
  }

  return {
    positions: positions.map((p) => ({
      id: p.id,
      name: p.name,
      votes_per_voter: p.votes_per_voter,
    })),
    candidatesByPosition,
  };
}

/**
 * Cédula de um desempate: apenas os cargos em disputa e, em cada um,
 * apenas os candidatos empatados.
 *
 * Lido sem cache e pelo cliente de serviço: `runoff_positions` é
 * deny-by-default sob RLS, e a janela do desempate é curta demais para
 * compensar o risco de servir uma cédula velha. `votes_per_voter` vem de
 * runoff_positions (vagas realmente em disputa), não do cargo.
 */
async function getRunoffBallotOptions(electionId: string): Promise<BallotOptions> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("runoff_positions")
    .select("position_id, votes_per_voter, positions ( name, display_order )")
    .eq("runoff_election_id", electionId);

  if (error) throw error;

  type PositionRow = {
    position_id: string;
    votes_per_voter: number;
    positions: { name: string; display_order: number } | null;
  };

  const rows = ((data ?? []) as unknown as PositionRow[])
    .filter((row) => row.positions !== null)
    .sort((a, b) => (a.positions!.display_order ?? 0) - (b.positions!.display_order ?? 0));

  const { data: candidateData, error: candidateError } = await supabase
    .from("runoff_candidates")
    .select("position_id, candidates ( id, full_name, photo_path, display_order )")
    .eq("runoff_election_id", electionId);

  if (candidateError) throw candidateError;

  type CandidateRow = {
    position_id: string;
    candidates: {
      id: string;
      full_name: string;
      photo_path: string | null;
      display_order: number;
    } | null;
  };

  const candidatesByPosition: Record<string, WizardCandidate[]> = {};
  for (const row of rows) candidatesByPosition[row.position_id] = [];

  for (const row of (candidateData ?? []) as unknown as CandidateRow[]) {
    if (!row.candidates) continue;
    (candidatesByPosition[row.position_id] ??= []).push({
      id: row.candidates.id,
      full_name: row.candidates.full_name,
      photo_path: row.candidates.photo_path,
    });
  }

  for (const key of Object.keys(candidatesByPosition)) {
    candidatesByPosition[key].sort(compareCandidatesByName);
  }

  return {
    positions: rows.map((row) => ({
      id: row.position_id,
      name: row.positions!.name,
      votes_per_voter: row.votes_per_voter,
    })),
    candidatesByPosition,
  };
}

/**
 * Opções da urna para a eleição da SESSÃO do eleitor — nunca "a eleição
 * ativa agora". O que a pessoa vê tem que ser exatamente o que a sessão
 * dela autoriza enviar, e é isso que `cast_ballot` vai validar de novo.
 */
export async function getBallotOptions(election: VoteSessionElection): Promise<BallotOptions> {
  return election.type === "runoff"
    ? getRunoffBallotOptions(election.electionId)
    : getGeneralBallotOptions();
}
