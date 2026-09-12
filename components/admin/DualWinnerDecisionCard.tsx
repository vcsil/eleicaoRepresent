"use client";

import { useActionState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { resolveDualWinnerAction, type ActionState } from "@/app/admin/(protected)/desempates/actions";
import type { PendingDualWinnerDecision } from "@/lib/admin/runoffs";

const initialState: ActionState = { error: null };

export function DualWinnerDecisionCard({ decision }: { decision: PendingDualWinnerDecision }) {
  const [state, formAction, isPending] = useActionState(resolveDualWinnerAction, initialState);

  return (
    <Card className="p-4">
      <p className="font-medium text-foreground">{decision.candidate_name}</p>
      <p className="text-sm text-foreground-muted">
        Eleito para {decision.position_name_a} e {decision.position_name_b} — qual cargo o
        candidato assume?
      </p>

      <form action={formAction} className="mt-3 flex flex-wrap items-center gap-3">
        <input type="hidden" name="decision_id" value={decision.id} />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="radio" name="chosen_position_id" value={decision.position_id_a} required />
          {decision.position_name_a}
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="radio" name="chosen_position_id" value={decision.position_id_b} required />
          {decision.position_name_b}
        </label>
        <Button type="submit" size="md" disabled={isPending}>
          {isPending ? "Registrando..." : "Registrar escolha"}
        </Button>
      </form>
      {state.error && <p className="mt-2 text-sm text-danger">{state.error}</p>}
    </Card>
  );
}
