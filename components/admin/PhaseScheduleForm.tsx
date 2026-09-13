"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { updatePhaseAction, type ScheduleFormState } from "@/app/admin/(protected)/cronograma/actions";
import type { ElectionPhase } from "@/lib/election/phase-bounds";

const initialState: ScheduleFormState = { error: null };

const inputClass =
  "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export function PhaseScheduleForm({ phase }: { phase: ElectionPhase }) {
  const [state, formAction, isPending] = useActionState(updatePhaseAction, initialState);

  return (
    <form action={formAction} className="rounded-lg border border-border bg-surface p-4">
      <input type="hidden" name="election_id" value={phase.election_id} />
      <input type="hidden" name="phase_key" value={phase.phase_key} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-foreground">{phase.label}</h3>
        {!phase.time_configured && <Badge tone="warning">Horário padrão (não configurado)</Badge>}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="text-xs font-medium text-foreground-muted">Data inicial</label>
          <input type="date" name="starts_on" defaultValue={phase.starts_on} className={inputClass} required />
        </div>
        <div>
          <label className="text-xs font-medium text-foreground-muted">Hora inicial</label>
          <input
            type="time"
            name="start_time"
            defaultValue={phase.start_time.slice(0, 5)}
            className={inputClass}
            required
          />
        </div>
        <div>
          <label className="text-xs font-medium text-foreground-muted">Data final</label>
          <input type="date" name="ends_on" defaultValue={phase.ends_on} className={inputClass} required />
        </div>
        <div>
          <label className="text-xs font-medium text-foreground-muted">Hora final</label>
          <input
            type="time"
            name="end_time"
            defaultValue={phase.end_time.slice(0, 5)}
            className={inputClass}
            required
          />
        </div>
      </div>

      {state.error && <p className="mt-2 text-sm text-danger">{state.error}</p>}
      {state.success && <p className="mt-2 text-sm text-success">Salvo.</p>}

      <div className="mt-3">
        <Button type="submit" size="md" disabled={isPending} variant="secondary">
          {isPending ? "Salvando..." : "Salvar"}
        </Button>
      </div>
    </form>
  );
}
