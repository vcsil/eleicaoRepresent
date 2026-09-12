import "server-only";
import { getActivePositions } from "@/lib/election/positions";
import { getActiveCandidates } from "@/lib/election/candidates";

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

export async function getBallotOptions(): Promise<{
  positions: WizardPosition[];
  candidatesByPosition: Record<string, WizardCandidate[]>;
}> {
  const [positions, candidates] = await Promise.all([getActivePositions(), getActiveCandidates()]);

  const candidatesByPosition: Record<string, WizardCandidate[]> = {};
  for (const position of positions) {
    candidatesByPosition[position.id] = candidates
      .filter((c) => c.positions.some((p) => p.id === position.id))
      .map((c) => ({ id: c.id, full_name: c.full_name, photo_path: c.photo_path }));
  }

  return {
    positions: positions.map((p) => ({ id: p.id, name: p.name, votes_per_voter: p.votes_per_voter })),
    candidatesByPosition,
  };
}
