"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";
import { publishResultsAction } from "@/app/admin/(protected)/resultados/actions";

/**
 * Usado pela eleição principal e pelo desempate. O texto muda porque a
 * consequência muda: publicar o desempate resolve o empate do pai, mas NÃO
 * publica a eleição principal — e quem clica precisa saber disso antes.
 */
export function PublishResultsButton({
  electionId,
  disabled,
  label = "Liberar resultados",
  description = "Tem certeza de que deseja tornar os resultados públicos? Esta ação não pode ser desfeita.",
}: {
  electionId: string;
  disabled: boolean;
  label?: string;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      setError(null);
      const formData = new FormData();
      formData.set("election_id", electionId);
      const result = await publishResultsAction({ error: null }, formData);
      if (result.error) setError(result.error);
      setOpen(false);
    });
  }

  return (
    <div>
      <Button type="button" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      <ConfirmationDialog
        open={open}
        title={label}
        description={description}
        confirmLabel="Sim, publicar"
        confirming={isPending}
        onCancel={() => setOpen(false)}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
