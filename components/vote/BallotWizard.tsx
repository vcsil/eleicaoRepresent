"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { VoteProgress } from "@/components/vote/VoteProgress";
import { VoteDistributionCard, type DistributionOption } from "@/components/vote/VoteDistributionCard";
import { BALLOT_DRAFT_STORAGE_KEY, NULL_OPTION_KEY, type BallotDraft } from "@/lib/vote/draft";
import type { WizardPosition, WizardCandidate } from "@/lib/election/ballot-options";

function readStoredDraft(): BallotDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(BALLOT_DRAFT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BallotDraft) : null;
  } catch {
    return null;
  }
}

export function BallotWizard({
  positions,
  candidatesByPosition,
}: {
  positions: WizardPosition[];
  candidatesByPosition: Record<string, WizardCandidate[]>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedStep = Number(searchParams.get("step") ?? "0");

  const [stepIndex, setStepIndex] = useState(
    Number.isFinite(requestedStep) && requestedStep >= 0 && requestedStep < positions.length
      ? requestedStep
      : 0,
  );
  const [draft, setDraft] = useState<BallotDraft>(() => readStoredDraft() ?? {});

  useEffect(() => {
    window.sessionStorage.setItem(BALLOT_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  }, [draft]);

  const position = positions[stepIndex];
  const candidates = candidatesByPosition[position.id] ?? [];

  const options: DistributionOption[] = [
    ...candidates.map((c) => ({ key: c.id, name: c.full_name, photoPath: c.photo_path })),
    { key: NULL_OPTION_KEY, name: "Nulo", isNullOption: true },
  ];

  const allocations = draft[position.id] ?? {};
  const total = Object.values(allocations).reduce((sum, qty) => sum + qty, 0);
  const canAdvance = total === position.votes_per_voter;

  function updateAllocation(key: string, quantity: number) {
    setDraft((prev) => ({
      ...prev,
      [position.id]: { ...prev[position.id], [key]: quantity },
    }));
  }

  function goToStep(index: number) {
    setStepIndex(index);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div>
      <VoteProgress step={stepIndex + 1} total={positions.length} />

      <VoteDistributionCard
        positionName={position.name}
        votesPerVoter={position.votes_per_voter}
        options={options}
        allocations={allocations}
        onChange={updateAllocation}
      />

      <div className="mt-8 flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => (stepIndex === 0 ? router.push("/votar") : goToStep(stepIndex - 1))}
        >
          Voltar
        </Button>

        {stepIndex < positions.length - 1 ? (
          <Button type="button" disabled={!canAdvance} onClick={() => goToStep(stepIndex + 1)}>
            Avançar
          </Button>
        ) : (
          <Button
            type="button"
            disabled={!canAdvance}
            onClick={() => router.push("/votar/revisao")}
          >
            Revisar votos
          </Button>
        )}
      </div>
    </div>
  );
}
