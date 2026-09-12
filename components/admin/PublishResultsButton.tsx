"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";
import { publishResultsAction } from "@/app/admin/(protected)/resultados/actions";

export function PublishResultsButton({
  electionId,
  disabled,
}: {
  electionId: string;
  disabled: boolean;
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
        Liberar resultados
      </Button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      <ConfirmationDialog
        open={open}
        title="Liberar resultados"
        description="Tem certeza de que deseja tornar os resultados públicos? Esta ação não pode ser desfeita."
        confirmLabel="Sim, publicar"
        confirming={isPending}
        onCancel={() => setOpen(false)}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
