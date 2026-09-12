import type { Metadata } from "next";
import { getMainElection, getElectionStatus, ELECTION_STATUS_LABELS } from "@/lib/election/status";
import { getParticipationPercentage } from "@/lib/election/participation";
import { MetricCard } from "@/components/admin/MetricCard";
import { ElectionControlPanel } from "@/components/admin/ElectionControlPanel";
import { EmptyState } from "@/components/feedback/EmptyState";

export const metadata: Metadata = { title: "Votação — Administração" };
export const dynamic = "force-dynamic";

export default async function AdminVotacaoPage() {
  const election = await getMainElection();
  if (!election) {
    return <EmptyState title="Nenhuma eleição cadastrada" />;
  }

  const [status, participation] = await Promise.all([
    getElectionStatus(election.id),
    getParticipationPercentage(election.id),
  ]);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-foreground">Votação</h1>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <MetricCard label="Status atual" value={ELECTION_STATUS_LABELS[status]} />
        <MetricCard label="Participação" value={`${participation.toFixed(1)}%`} />
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-semibold text-foreground">Ações</h2>
        <p className="mt-1 text-sm text-foreground-muted">
          Resultados parciais não são exibidos aqui nem em nenhum outro lugar antes do
          encerramento (seção 87 do documento técnico).
        </p>
        <div className="mt-4">
          <ElectionControlPanel electionId={election.id} status={status} />
        </div>
      </div>
    </div>
  );
}
