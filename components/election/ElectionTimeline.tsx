import { getPhaseTimelineState, type ElectionPhase } from "@/lib/election/phase-bounds";

function formatDateRange(phase: ElectionPhase): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00-03:00`).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
    });
  return phase.starts_on === phase.ends_on
    ? fmt(phase.starts_on)
    : `${fmt(phase.starts_on)} a ${fmt(phase.ends_on)}`;
}

export function ElectionTimeline({ phases }: { phases: ElectionPhase[] }) {
  const now = new Date();

  return (
    <ol className="relative space-y-6 border-l border-border pl-6">
      {phases.map((phase) => {
        const state = getPhaseTimelineState(phase, now);
        return (
          <li key={phase.id} className="relative">
            <span
              className={`absolute -left-[1.6rem] top-1 h-3 w-3 rounded-full border-2 border-surface ${
                state === "past"
                  ? "bg-foreground-muted"
                  : state === "current"
                    ? "bg-primary"
                    : "bg-border"
              }`}
              aria-hidden="true"
            />
            <p
              className={`text-sm font-medium ${
                state === "future" ? "text-foreground-muted" : "text-foreground"
              }`}
            >
              {phase.label}
              {state === "current" && (
                <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                  agora
                </span>
              )}
            </p>
            <p className="text-xs text-foreground-muted">{formatDateRange(phase)}</p>
          </li>
        );
      })}
    </ol>
  );
}
