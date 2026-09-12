"use client";

import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  confirming,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={open} onClose={onCancel} title={title}>
      <p className="text-sm text-foreground-muted">{description}</p>
      <div className="mt-6 flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={confirming}>
          Cancelar
        </Button>
        <Button type="button" onClick={onConfirm} disabled={confirming}>
          {confirming ? "Registrando..." : confirmLabel}
        </Button>
      </div>
    </Sheet>
  );
}
