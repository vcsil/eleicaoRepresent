import type { Metadata } from "next";
import { getMainElection } from "@/lib/election/status";
import { getPendingTies, getPendingDualWinnerDecisions, getRunoffs } from "@/lib/admin/runoffs";
import { DualWinnerDecisionCard } from "@/components/admin/DualWinnerDecisionCard";
import { CreateRunoffForm } from "@/components/admin/CreateRunoffForm";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/feedback/EmptyState";

export const metadata: Metadata = { title: "Desempates — Administração" };
export const dynamic = "force-dynamic";

export default async function AdminDesempatesPage() {
  const election = await getMainElection();
  if (!election) {
    return <EmptyState title="Nenhuma eleição cadastrada" />;
  }

  const [ties, dualWinners, runoffs] = await Promise.all([
    getPendingTies(election.id),
    getPendingDualWinnerDecisions(election.id),
    getRunoffs(election.id),
  ]);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-foreground">Desempates e pendências</h1>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-foreground">Candidatos eleitos em dois cargos</h2>
        {dualWinners.length === 0 ? (
          <p className="mt-2 text-sm text-foreground-muted">Nenhuma pendência.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {dualWinners.map((d) => (
              <DualWinnerDecisionCard key={d.id} decision={d} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold text-foreground">Empates pendentes</h2>
        <p className="mt-1 text-xs text-foreground-muted">
          O critério de desempate nunca é automático — crie uma votação de desempate para cada
          empate abaixo.
        </p>
        {ties.length === 0 ? (
          <p className="mt-2 text-sm text-foreground-muted">Nenhum empate pendente.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {ties.map((tie) => (
              <CreateRunoffForm key={tie.position_id} tie={tie} electionId={election.id} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold text-foreground">Votações de desempate criadas</h2>
        {runoffs.length === 0 ? (
          <p className="mt-2 text-sm text-foreground-muted">Nenhuma até o momento.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {runoffs.map((r) => (
              <Card key={r.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span className="text-foreground">{r.name}</span>
                <Badge tone={r.results_published_at ? "success" : r.results_computed_at ? "warning" : "info"}>
                  {r.results_published_at
                    ? "Publicado"
                    : r.results_computed_at
                      ? "Apurado"
                      : "Em andamento"}
                </Badge>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
