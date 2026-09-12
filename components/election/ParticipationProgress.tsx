export function ParticipationProgress({ percentage }: { percentage: number }) {
  const clamped = Math.min(100, Math.max(0, percentage));

  return (
    <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-foreground-muted">Participação da turma</p>
        <p className="text-xl font-semibold text-foreground">{clamped.toFixed(1)}%</p>
      </div>
      <div
        className="mt-3 h-2.5 overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Percentual de eleitores que já votaram"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-foreground-muted">
        {clamped.toFixed(1)}% da turma já votou até o momento.
      </p>
    </div>
  );
}
