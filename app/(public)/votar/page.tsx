import type { Metadata } from "next";
import { getMainElection, getElectionStatus, isVotingOpen } from "@/lib/election/status";
import { VoterValidationForm } from "@/components/vote/VoterValidationForm";
import { EmptyState } from "@/components/feedback/EmptyState";
import { Button } from "@/components/ui/Button";
import { trackPageView } from "@/lib/analytics/track";

export const metadata: Metadata = { title: "Votar" };
export const dynamic = "force-dynamic";

export default async function VotarPage() {
  trackPageView("/votar");
  const election = await getMainElection();

  if (!election) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState title="Eleição não configurada" />
      </div>
    );
  }

  const status = await getElectionStatus(election.id);

  if (!isVotingOpen(status)) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="A votação não está disponível no momento"
          description="Confira a página inicial para ver o status atual da eleição e o cronograma."
          action={<Button href="/">Voltar ao início</Button>}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-center text-2xl font-semibold text-foreground">Identifique-se para votar</h1>
      <p className="mt-2 text-center text-sm text-foreground-muted">
        Informe sua matrícula e seu nome completo, exatamente como constam na lista oficial de
        eleitores.
      </p>
      <div className="mt-8 rounded-lg border border-border bg-surface p-6 shadow-sm">
        <VoterValidationForm />
      </div>
    </div>
  );
}
