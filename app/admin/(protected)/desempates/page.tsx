import type { Metadata } from "next";
import Link from "next/link";
import { getMainElection } from "@/lib/election/status";
import {
  getPendingTies,
  getPendingDualWinnerDecisions,
  getRunoffs,
  RUNOFF_STAGE_LABELS,
  type RunoffStage,
} from "@/lib/admin/runoffs";
import { DualWinnerDecisionCard } from "@/components/admin/DualWinnerDecisionCard";
import { CreateRunoffForm } from "@/components/admin/CreateRunoffForm";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/feedback/EmptyState";

export const metadata: Metadata = { title: "Desempates — Administração" };
export const dynamic = "force-dynamic";

const STAGE_TONE: Record<RunoffStage, "neutral" | "success" | "warning" | "info"> = {
  agendado: "neutral",
  votacao_aberta: "success",
  aguardando_apuracao: "info",
  apurado: "warning",
  novo_empate: "warning",
  concluido: "success",
};

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
              <Card key={r.id} className="p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-foreground">{r.name}</p>
                    {r.positions.length > 0 && (
                      <p className="mt-0.5 text-xs text-foreground-muted">
                        {r.positions.length === 1 ? "Cargo" : "Cargos"}: {r.positions.join(", ")}
                      </p>
                    )}
                  </div>
                  <Badge tone={STAGE_TONE[r.stage]}>{RUNOFF_STAGE_LABELS[r.stage]}</Badge>
                </div>
                {r.stage === "novo_empate" && (
                  <p className="mt-2 text-xs text-warning">
                    A votação de desempate terminou empatada. Nada é decidido automaticamente —
                    é preciso criar uma nova rodada para este cargo.
                  </p>
                )}
                {r.stage === "apurado" && (
                  <p className="mt-2 text-xs text-foreground-muted">
                    Publique esta votação na página dela: é isso que resolve o empate da eleição
                    principal e libera a publicação dela.
                  </p>
                )}
                <Link
                  href={`/admin/desempates/${r.id}`}
                  className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
                >
                  Gerenciar votação de desempate →
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
