"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { invalidateAllCachesAction } from "@/app/admin/(protected)/dashboard/actions";

/**
 * Escape manual para quando os dados forem alterados direto no banco
 * (SQL Editor, psql) em vez de pelo painel — nesse caminho nenhuma
 * Server Action roda, então nada invalida o cache automaticamente.
 *
 * Ação barata e sem efeito destrutivo (no pior caso as próximas cargas
 * consultam o Supabase de novo), então não pede confirmação.
 */
export function InvalidateCacheButton() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      setError(null);
      setDone(false);
      const result = await invalidateAllCachesAction();
      if (result.error) setError(result.error);
      else setDone(true);
    });
  }

  return (
    <div>
      <Button type="button" variant="secondary" disabled={isPending} onClick={handleClick}>
        {isPending ? "Atualizando…" : "Atualizar dados do site"}
      </Button>
      <p className="mt-2 max-w-prose text-sm text-foreground-muted">
        Use se você alterou cargos, candidatos ou o cronograma direto no banco de dados. As
        alterações feitas por este painel já aparecem no site automaticamente.
      </p>
      {done && (
        <p className="mt-2 text-sm text-success" role="status">
          Dados atualizados. O site já está servindo as informações mais recentes.
        </p>
      )}
      {error && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
