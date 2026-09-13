import type { Metadata } from "next";
import { getMainElection, getElectionStatus } from "@/lib/election/status";
import { ELECTION_STATUS_LABELS } from "@/lib/election/status";
import { getParticipationPercentage } from "@/lib/election/participation";
import { getDashboardMetrics } from "@/lib/admin/metrics";
import { MetricCard } from "@/components/admin/MetricCard";
import { EmptyState } from "@/components/feedback/EmptyState";
import { InvalidateCacheButton } from "@/components/admin/InvalidateCacheButton";

export const metadata: Metadata = { title: "Painel — Administração" };
export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const election = await getMainElection();

  if (!election) {
    return <EmptyState title="Nenhuma eleição cadastrada" />;
  }

  const [status, participation, metrics] = await Promise.all([
    getElectionStatus(election.id),
    getParticipationPercentage(election.id),
    getDashboardMetrics(election.id),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-foreground">Painel</h1>
      <p className="mt-1 text-sm text-foreground-muted">{election.name}</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Status da eleição" value={ELECTION_STATUS_LABELS[status]} />
        <MetricCard label="Eleitores habilitados" value={metrics.totalVoters} />
        <MetricCard label="Participação" value={`${participation.toFixed(1)}%`} />
        <MetricCard label="Candidatos ativos" value={metrics.totalCandidates} />
        <MetricCard label="Acessos ao site" value={metrics.totalSiteViews} />
        <MetricCard label="Tentativas inválidas de validação" value={metrics.invalidAttempts} />
        <MetricCard label="Tentativas de voto duplicado" value={metrics.duplicateVoteAttempts} />
        <MetricCard label="Eventos de segurança" value={metrics.securityEvents} />
        <MetricCard
          label="Apuração"
          value={metrics.resultsComputed ? "Concluída" : "Pendente"}
        />
        <MetricCard
          label="Publicação dos resultados"
          value={metrics.resultsPublished ? "Publicado" : "Não publicado"}
        />
        <MetricCard
          label="Empates pendentes"
          value={metrics.tiesPending}
          hint={metrics.tiesPending > 0 ? "Requer desempate — veja /admin/desempates" : undefined}
        />
        <MetricCard
          label="Cargo duplo pendente"
          value={metrics.dualWinnersPending}
          hint={
            metrics.dualWinnersPending > 0
              ? "Candidato eleito em 2 cargos aguardando decisão"
              : undefined
          }
        />
      </div>

      <section className="mt-10 border-t border-border pt-6">
        <h2 className="text-lg font-semibold text-foreground">Cache do site</h2>
        <div className="mt-3">
          <InvalidateCacheButton />
        </div>
      </section>
    </div>
  );
}
