import type { Metadata } from "next";
import { getMainElection } from "@/lib/election/status";
import { getElectionPhases } from "@/lib/election/phases";
import { PhaseScheduleForm } from "@/components/admin/PhaseScheduleForm";
import { EmptyState } from "@/components/feedback/EmptyState";

export const metadata: Metadata = { title: "Cronograma — Administração" };
export const dynamic = "force-dynamic";

export default async function AdminCronogramaPage() {
  const election = await getMainElection();
  if (!election) {
    return <EmptyState title="Nenhuma eleição cadastrada" />;
  }

  const phases = await getElectionPhases(election.id);

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-foreground">Cronograma</h1>
      <p className="mt-1 text-sm text-foreground-muted">
        As datas seguem o edital oficial. Configure o horário exato de início e fim de cada etapa —
        enquanto não configurado, o sistema usa 00:00–23:59:59 do dia.
      </p>

      <div className="mt-6 space-y-4">
        {phases.map((phase) => (
          <PhaseScheduleForm key={phase.id} phase={phase} />
        ))}
      </div>
    </div>
  );
}
