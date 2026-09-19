"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Sheet } from "@/components/ui/Sheet";
import { YouTubePlayer } from "@/components/candidates/YouTubePlayer";
import { EmptyState } from "@/components/feedback/EmptyState";
import { candidatePhotoUrl } from "@/lib/media/candidate-photo";
import type { CandidateWithPositions } from "@/lib/election/candidates";

type PositionFilter = { id: string; slug: string; name: string };

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function Avatar({ name, photoPath, size }: { name: string; photoPath: string | null; size: number }) {
  const url = candidatePhotoUrl(photoPath);
  if (url) {
    return (
      <Image
        src={url}
        alt={`Fotografia de ${name}`}
        width={size}
        height={size}
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary"
      style={{ width: size, height: size, fontSize: size / 2.6 }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function CandidatesExplorer({
  candidates,
  positions,
}: {
  candidates: CandidateWithPositions[];
  positions: PositionFilter[];
}) {
  const [filter, setFilter] = useState<string>("todos");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (filter === "todos") return candidates;
    return candidates.filter((c) => c.positions.some((p) => p.slug === filter));
  }, [candidates, filter]);

  const selected = candidates.find((c) => c.id === selectedId) ?? null;

  return (
    <>
      <div className="mb-8 flex flex-wrap justify-center gap-2" role="tablist" aria-label="Filtrar por cargo">
        <button
          type="button"
          role="tab"
          aria-selected={filter === "todos"}
          onClick={() => setFilter("todos")}
          className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
            filter === "todos"
              ? "bg-primary text-primary-foreground"
              : "bg-surface-muted text-foreground-muted hover:text-foreground"
          }`}
        >
          Todos
        </button>
        {positions.map((position) => (
          <button
            key={position.id}
            type="button"
            role="tab"
            aria-selected={filter === position.slug}
            onClick={() => setFilter(position.slug)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              filter === position.slug
                ? "bg-primary text-primary-foreground"
                : "bg-surface-muted text-foreground-muted hover:text-foreground"
            }`}
          >
            {position.name}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Nenhum candidato neste filtro"
          description="Experimente selecionar outro cargo."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((candidate) => (
            <Card key={candidate.id} className="p-5">
              <button
                type="button"
                className="flex w-full flex-col items-center text-center"
                onClick={() => setSelectedId(candidate.id)}
              >
                <Avatar name={candidate.full_name} photoPath={candidate.photo_path} size={72} />
                <h3 className="mt-3 font-medium text-foreground">{candidate.full_name}</h3>
                <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                  {candidate.positions.map((p) => (
                    <Badge key={p.id} tone="info">
                      {p.name}
                    </Badge>
                  ))}
                </div>
              </button>
            </Card>
          ))}
        </div>
      )}

      <Sheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected?.full_name ?? ""}
      >
        {selected && (
          <div className="space-y-5">
            <div className="flex flex-col items-center text-center">
              <Avatar name={selected.full_name} photoPath={selected.photo_path} size={112} />
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {selected.positions.map((p) => (
                  <Badge key={p.id} tone="info">
                    {p.name}
                  </Badge>
                ))}
              </div>
              {selected.tagline && (
                <p className="mt-2 text-sm italic text-foreground-muted">
                  &ldquo;{selected.tagline}&rdquo;
                </p>
              )}
            </div>

            {selected.video_url && (
              <YouTubePlayer
                url={selected.video_url}
                title={selected.full_name}
                candidateId={selected.id}
              />
            )}

            {selected.presentation && (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Apresentação</h3>
                <p className="mt-1.5 whitespace-pre-line text-sm text-foreground-muted">
                  {selected.presentation}
                </p>
              </div>
            )}

            {selected.proposals && (
              <div>
                <h3 className="text-sm font-semibold text-foreground">Propostas</h3>
                <p className="mt-1.5 whitespace-pre-line text-sm text-foreground-muted">
                  {selected.proposals}
                </p>
              </div>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}
