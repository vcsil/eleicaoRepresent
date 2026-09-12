"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Sheet } from "@/components/ui/Sheet";
import type { Position } from "@/lib/election/positions";

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function PositionsGrid({ positions }: { positions: Position[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = positions.find((p) => p.id === selectedId) ?? null;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {positions.map((position) => (
          <Card
            key={position.id}
            className="cursor-pointer p-5 text-left transition-shadow hover:shadow-md"
          >
            <button
              type="button"
              className="w-full text-left"
              onClick={() => setSelectedId(position.id)}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {initials(position.name)}
                </span>
                <div>
                  <h3 className="font-medium text-foreground">{position.name}</h3>
                  <p className="text-xs text-foreground-muted">
                    {position.vacancies} {position.vacancies === 1 ? "vaga" : "vagas"}
                  </p>
                </div>
              </div>
              {position.description && (
                <p className="mt-3 text-sm text-foreground-muted">{position.description}</p>
              )}
            </button>
          </Card>
        ))}
      </div>

      <Sheet open={selected !== null} onClose={() => setSelectedId(null)} title={selected?.name ?? ""}>
        {selected && (
          <div className="space-y-5">
            <p className="text-sm text-foreground-muted">
              {selected.vacancies} {selected.vacancies === 1 ? "vaga" : "vagas"}
              {selected.seat_labels && selected.seat_labels.length > 0 && (
                <> — {selected.seat_labels.join(" e ")}</>
              )}
            </p>
            {selected.description && (
              <p className="text-sm text-foreground">{selected.description}</p>
            )}
            {selected.responsibilities && (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Principais atribuições</h3>
                <p className="mt-1.5 text-sm text-foreground-muted">{selected.responsibilities}</p>
              </div>
            )}
            {selected.profile && (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Perfil desejado</h3>
                <p className="mt-1.5 text-sm text-foreground-muted">{selected.profile}</p>
              </div>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}
