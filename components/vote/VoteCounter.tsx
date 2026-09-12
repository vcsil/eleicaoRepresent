"use client";

import Image from "next/image";
import { candidatePhotoUrl } from "@/lib/media/candidate-photo";

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function VoteCounter({
  name,
  photoPath,
  isNullOption = false,
  quantity,
  canIncrement,
  onIncrement,
  onDecrement,
}: {
  name: string;
  photoPath?: string | null;
  isNullOption?: boolean;
  quantity: number;
  canIncrement: boolean;
  onIncrement: () => void;
  onDecrement: () => void;
}) {
  const photoUrl = photoPath ? candidatePhotoUrl(photoPath) : null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {isNullOption ? (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-foreground-muted">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
        ) : photoUrl ? (
          <Image
            src={photoUrl}
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {initials(name)}
          </span>
        )}
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={onDecrement}
          disabled={quantity <= 0}
          aria-label={`Remover um voto de ${name}`}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border text-lg font-medium text-foreground disabled:opacity-30"
        >
          −
        </button>
        <span className="w-5 text-center text-base font-semibold tabular-nums text-foreground" aria-live="polite">
          {quantity}
        </span>
        <button
          type="button"
          onClick={onIncrement}
          disabled={!canIncrement}
          aria-label={`Adicionar um voto para ${name}`}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border text-lg font-medium text-foreground disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  );
}
