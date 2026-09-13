"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { adminLoginAction, type AdminLoginState } from "@/app/admin/actions";

const initialState: AdminLoginState = { error: null };

export function AdminLoginForm({ expired = false }: { expired?: boolean }) {
  const [state, formAction, isPending] = useActionState(adminLoginAction, initialState);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {expired && !state.error && (
        <p role="status" className="rounded-md bg-warning-bg px-3.5 py-3 text-sm text-foreground">
          Sua sessão expirou por inatividade. Entre novamente.
        </p>
      )}
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-foreground">
          Senha administrativa
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1.5 block h-12 w-full rounded-md border border-border bg-surface px-3.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        />
      </div>

      {state.error && (
        <p role="alert" className="rounded-md bg-danger-bg px-3.5 py-3 text-sm text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={isPending} className="w-full" size="lg">
        {isPending ? "Entrando..." : "Entrar"}
      </Button>
    </form>
  );
}
