"use client";

import { VoteCounter } from "@/components/vote/VoteCounter";
import { NULL_OPTION_KEY } from "@/lib/vote/draft";

export type DistributionOption = {
  key: string;
  name: string;
  photoPath?: string | null;
  isNullOption?: boolean;
};

export function VoteDistributionCard({
  positionName,
  votesPerVoter,
  options,
  allocations,
  onChange,
}: {
  positionName: string;
  votesPerVoter: number;
  options: DistributionOption[];
  allocations: Record<string, number>;
  onChange: (key: string, quantity: number) => void;
}) {
  const total = Object.values(allocations).reduce((sum, qty) => sum + qty, 0);
  const complete = total === votesPerVoter;

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-foreground">{positionName}</h2>
        <p className="text-sm text-foreground-muted">
          Distribua {votesPerVoter} {votesPerVoter === 1 ? "voto" : "votos"}
        </p>
      </div>

      <div className="space-y-2.5">
        {options.map((option) => (
          <VoteCounter
            key={option.key}
            name={option.name}
            photoPath={option.isNullOption ? undefined : option.photoPath}
            isNullOption={option.key === NULL_OPTION_KEY}
            quantity={allocations[option.key] ?? 0}
            canIncrement={total < votesPerVoter}
            onIncrement={() => onChange(option.key, (allocations[option.key] ?? 0) + 1)}
            onDecrement={() => onChange(option.key, Math.max(0, (allocations[option.key] ?? 0) - 1))}
          />
        ))}
      </div>

      <p
        className={`mt-4 rounded-md px-3.5 py-2.5 text-center text-sm font-medium ${
          complete ? "bg-success-bg text-success" : "bg-surface-muted text-foreground-muted"
        }`}
        aria-live="polite"
      >
        {total} de {votesPerVoter} votos distribuídos
      </p>
    </div>
  );
}
