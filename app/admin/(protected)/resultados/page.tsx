import type { Metadata } from "next";
import { getMainElection } from "@/lib/election/status";
import { getInternalResultsByPosition } from "@/lib/admin/results";
import { seatGapLabel } from "@/lib/election/seat-gaps";
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

  const sections = await getInternalResultsByPosition(election.id);
  const hasTies = sections.some((s) => s.rows.some((r) => r.tie_break_needed));

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
        {sections.map((section) => {
          // Cargo sem disputa: as linhas vêm marcadas por compute_results e
          // não têm contagem nenhuma — mostrar "0 votos" seria descrever uma
          // votação que não aconteceu.
          const semDisputa = section.rows.some((row) => row.unopposed);
          const candidatos = section.rows.filter((row) => row.candidate_id !== null);
          const nulos = section.rows.filter((row) => row.candidate_id === null);

          return (
            <section key={section.positionId}>
              <h2 className="mb-2 font-semibold text-foreground">
                {section.positionName}
                {section.vacancies !== null && (
                  <span className="ml-2 text-xs font-normal text-foreground-muted">
                    {section.electedCount}/{section.vacancies}{" "}
                    {section.vacancies === 1 ? "vaga preenchida" : "vagas preenchidas"}
                  </span>
                )}
              </h2>
              <Card className="divide-y divide-border">
                {candidatos.length === 0 && section.rows.length === 0 && (
                  <p className="p-3 text-sm text-foreground-muted">
                    Nenhuma candidatura registrada para este cargo.
                  </p>
                )}
                {candidatos.map((row) => (
                  <div
                    key={row.candidate_id ?? "null"}
                    className="flex items-center justify-between gap-3 p-3 text-sm"
                  >
                    <span className="min-w-0 break-words text-foreground">
                      {row.unopposed ? row.candidate_name : `${row.rank}º ${row.candidate_name}`}
                      {row.seat_label && (
                        <span className="ml-2 text-xs text-foreground-muted">({row.seat_label})</span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {!row.unopposed && (
                        <span className="tabular-nums text-foreground-muted">
                          {row.votes_count} votos
                        </span>
                      )}
                      {row.elected && (
                        <Badge tone="success">
                          {row.unopposed ? "Eleito sem disputa" : "Eleito"}
                        </Badge>
                      )}
                      {row.tie_break_needed && <Badge tone="warning">Empate</Badge>}
                    </span>
                  </div>
                ))}
                {!semDisputa &&
                  nulos.map((row) => (
                    <div
                      key="null"
                      className="flex items-center justify-between gap-3 p-3 text-sm text-foreground-muted"
                    >
                      <span>Votos nulos</span>
                      <span className="tabular-nums">{row.votes_count} votos</span>
                    </div>
                  ))}
                {section.seatGaps.map((gap) => (
                  <div key={gap.reason} className="p-3 text-sm text-foreground-muted">
                    {seatGapLabel(gap.reason, gap.seats)}
                  </div>
                ))}
              </Card>
            </section>
          );
        })}
      </div>
    </div>
  );
}
