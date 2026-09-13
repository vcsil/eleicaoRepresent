"use client";

import { useActionState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { createRunoffAction, type ActionState } from "@/app/admin/(protected)/desempates/actions";
import type { PendingTie } from "@/lib/admin/runoffs";

const initialState: ActionState = { error: null };

const inputClass =
  "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export function CreateRunoffForm({ tie, electionId }: { tie: PendingTie; electionId: string }) {
  const [state, formAction, isPending] = useActionState(createRunoffAction, initialState);

  return (
    <Card className="p-4">
      <p className="font-medium text-foreground">{tie.position_name}</p>
      <p className="text-sm text-foreground-muted">
        Empate entre: {tie.candidates.map((c) => `${c.name} (${c.votes_count} votos)`).join(", ")}
      </p>

      <form action={formAction} className="mt-4 space-y-3">
        <input type="hidden" name="parent_election_id" value={electionId} />
        <input type="hidden" name="position_ids" value={tie.position_id} />

        <div>
          <label className="text-xs font-medium text-foreground-muted">Motivo</label>
          <input
            name="reason"
            required
            maxLength={500}
            defaultValue={`Empate para vaga(s) de ${tie.position_name}`}
            className={inputClass}
          />
        </div>

        <p className="rounded-md bg-surface-muted px-3 py-2 text-xs text-foreground-muted">
          Os candidatos em disputa e o número de vagas são determinados pela apuração — não
          precisam ser informados aqui.
        </p>

        {/* Mesmo motivo do cronograma: date/time não encolhem, transbordam. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <label className="text-xs font-medium text-foreground-muted">Data inicial</label>
            <input type="date" name="starts_on" required className={inputClass} />
          </div>
          <div className="min-w-0">
            <label className="text-xs font-medium text-foreground-muted">Hora inicial</label>
            <input type="time" name="start_time" required defaultValue="08:00" className={inputClass} />
          </div>
          <div className="min-w-0">
            <label className="text-xs font-medium text-foreground-muted">Data final</label>
            <input type="date" name="ends_on" required className={inputClass} />
          </div>
          <div className="min-w-0">
            <label className="text-xs font-medium text-foreground-muted">Hora final</label>
            <input type="time" name="end_time" required defaultValue="18:00" className={inputClass} />
          </div>
        </div>

        {state.error && <p className="text-sm text-danger">{state.error}</p>}

        <Button type="submit" size="md" disabled={isPending}>
          {isPending ? "Criando..." : "Criar votação de desempate"}
        </Button>
      </form>
    </Card>
  );
}
