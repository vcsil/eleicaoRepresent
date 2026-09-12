"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Modal centralizado em telas largas, bottom sheet em telas estreitas
 * (seção 4). Baseado em <dialog> nativo: foco preso, ESC fecha, backdrop
 * acessível sem JS extra.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
      className="fixed inset-x-0 bottom-0 m-0 w-full max-w-full rounded-t-2xl border-t border-border bg-surface p-0 shadow-lg backdrop:bg-foreground/40 backdrop:backdrop-blur-[2px] sm:inset-0 sm:m-auto sm:w-full sm:max-w-lg sm:rounded-2xl sm:border"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="rounded-md p-1.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="max-h-[75vh] overflow-y-auto p-5 sm:max-h-[70vh]">{children}</div>
    </dialog>
  );
}
