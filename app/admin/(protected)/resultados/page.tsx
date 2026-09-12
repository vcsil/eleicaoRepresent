import type { Metadata } from "next";
import { getMainElection } from "@/lib/election/status";
import { getInternalResults } from "@/lib/admin/results";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { PublishResultsButton } from "@/components/admin/PublishResultsButton";
import { EmptyState } from "@/components/feedback/EmptyState";

export const metadata: Metadata = { title: "Resultados — Administração" };
export const dynamic = "force-dynamic";

export default async function AdminResultadosPage() {
  const election = await getMainElection();
  if (!election) {
    return <EmptyState title="Nenhuma eleição cadastrada" />;
  }

  if (!election.results_computed_at) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold text-foreground">Resultados</h1>
        <div className="mt-6">
          <EmptyState
            title="Apuração ainda não realizada"
            description="Inicie a apuração em /admin/votacao para visualizar os resultados internos aqui."
          />
        </div>
      </div>
    );
  }

  const results = await getInternalResults(election.id);
  const byPosition = new Map<string, typeof results>();
  for (const row of results) {
    const list = byPosition.get(row.position_id) ?? [];
    list.push(row);
    byPosition.set(row.position_id, list);
  }

  const hasTies = results.some((r) => r.tie_break_needed);

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-foreground">Resultados (visão interna)</h1>
        <PublishResultsButton electionId={election.id} disabled={Boolean(election.results_published_at)} />
      </div>

      {election.results_published_at ? (
        <p className="mt-2 text-sm text-success">
          Resultados publicados em {new Date(election.results_published_at).toLocaleString("pt-BR")}.
        </p>
      ) : (
        <p className="mt-2 text-sm text-foreground-muted">
          Ainda não publicado. Revise os dados abaixo antes de liberar.
        </p>
      )}

      {hasTies && (
        <p className="mt-2 rounded-md bg-warning-bg px-3.5 py-2.5 text-sm text-warning">
          Há empates pendentes — resolva em /admin/desempates antes de publicar.
        </p>
      )}

      <div className="mt-6 space-y-6">
        {Array.from(byPosition.entries()).map(([positionId, rows]) => (
          <section key={positionId}>
            <h2 className="mb-2 font-semibold text-foreground">{rows[0]?.position_name}</h2>
            <Card className="divide-y divide-border">
              {rows.map((row) => (
                <div
                  key={row.candidate_id ?? "null"}
                  className="flex items-center justify-between gap-3 p-3 text-sm"
                >
                  <span className="text-foreground">
                    {row.candidate_id ? `${row.rank}º ${row.candidate_name}` : "Votos nulos"}
                    {row.seat_label && (
                      <span className="ml-2 text-xs text-foreground-muted">({row.seat_label})</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums text-foreground-muted">{row.votes_count} votos</span>
                    {row.elected && <Badge tone="success">Eleito</Badge>}
                    {row.tie_break_needed && <Badge tone="warning">Empate</Badge>}
                  </span>
                </div>
              ))}
            </Card>
          </section>
        ))}
      </div>
    </div>
  );
}
