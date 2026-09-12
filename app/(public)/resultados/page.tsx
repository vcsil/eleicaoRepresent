import type { Metadata } from "next";
import Image from "next/image";
import { getMainElection, getElectionStatus } from "@/lib/election/status";
import { getActivePositions } from "@/lib/election/positions";
import { getPublishedResults, type ResultSnapshotRow } from "@/lib/election/results";
import { candidatePhotoUrl } from "@/lib/media/candidate-photo";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/feedback/EmptyState";

export const metadata: Metadata = { title: "Resultados" };
export const dynamic = "force-dynamic";

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export default async function ResultadosPage() {
  const election = await getMainElection();

  if (!election) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState title="Eleição não configurada" />
      </div>
    );
  }

  const status = await getElectionStatus(election.id);

  if (status !== "resultado_disponivel") {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="Os resultados ainda não foram divulgados"
          description="Assim que a apuração for concluída e revisada pela administração, os resultados aparecerão aqui."
        />
      </div>
    );
  }

  const [positions, results] = await Promise.all([
    getActivePositions(),
    getPublishedResults(election.id),
  ]);

  const byPosition = new Map<string, ResultSnapshotRow[]>();
  for (const row of results) {
    const list = byPosition.get(row.position_id) ?? [];
    list.push(row);
    byPosition.set(row.position_id, list);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <header className="mb-10 text-center">
        <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">
          Resultados da eleição
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-foreground-muted">
          Composição eleita da Comissão de Formatura — Turma 36.
        </p>
      </header>

      <div className="space-y-8">
        {positions.map((position) => {
          const rows = byPosition.get(position.id) ?? [];
          const candidates = rows
            .filter((r) => r.candidate_id !== null)
            .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
          const nullRow = rows.find((r) => r.candidate_id === null);

          if (rows.length === 0) return null;

          return (
            <section key={position.id}>
              <h2 className="mb-3 text-lg font-semibold text-foreground">{position.name}</h2>
              <Card className="divide-y divide-border">
                {candidates.map((row) => {
                  const photoUrl = candidatePhotoUrl(row.candidate_photo_path);
                  return (
                    <div key={row.candidate_id} className="flex items-center gap-3 p-4">
                      <span className="w-6 shrink-0 text-center text-sm font-semibold text-foreground-muted">
                        {row.rank}º
                      </span>
                      {photoUrl ? (
                        <Image
                          src={photoUrl}
                          alt=""
                          width={44}
                          height={44}
                          className="h-11 w-11 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                          {initials(row.candidate_name ?? "?")}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-foreground">{row.candidate_name}</p>
                        {row.seat_label && (
                          <p className="text-xs text-foreground-muted">{row.seat_label}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-sm font-semibold tabular-nums text-foreground">
                          {row.votes_count} {row.votes_count === 1 ? "voto" : "votos"}
                        </span>
                        {row.elected && <Badge tone="success">Eleito</Badge>}
                      </div>
                    </div>
                  );
                })}
                {nullRow && (
                  <div className="flex items-center justify-between p-4 text-sm text-foreground-muted">
                    <span>Votos nulos</span>
                    <span className="font-medium tabular-nums text-foreground">
                      {nullRow.votes_count}
                    </span>
                  </div>
                )}
              </Card>
            </section>
          );
        })}
      </div>
    </div>
  );
}
