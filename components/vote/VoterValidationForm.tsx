"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { validateVoterAction, type ValidateVoterState } from "@/app/(public)/votar/actions";

const initialState: ValidateVoterState = { error: null };

export function VoterValidationForm() {
  const [state, formAction, isPending] = useActionState(validateVoterAction, initialState);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <div>
        <label htmlFor="registration_number" className="block text-sm font-medium text-foreground">
          Número de matrícula
        </label>
        <input
          id="registration_number"
          name="registration_number"
          type="text"
          autoComplete="off"
          required
          maxLength={50}
          className="mt-1.5 block h-12 w-full rounded-md border border-border bg-surface px-3.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        />
      </div>

      <div>
        <label htmlFor="full_name" className="block text-sm font-medium text-foreground">
          Nome completo
        </label>
        <input
          id="full_name"
          name="full_name"
          type="text"
          autoComplete="off"
          required
          maxLength={200}
          className="mt-1.5 block h-12 w-full rounded-md border border-border bg-surface px-3.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        />
      </div>

      {state.error && (
        <p role="alert" className="rounded-md bg-danger-bg px-3.5 py-3 text-sm text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={isPending} className="w-full" size="lg">
        {isPending ? "Validando..." : "Continuar"}
      </Button>
    </form>
  );
}
