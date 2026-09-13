import type { Metadata } from "next";
import { getCurrentVotingElection } from "@/lib/election/active-election";
import { VoterValidationForm } from "@/components/vote/VoterValidationForm";
import { EmptyState } from "@/components/feedback/EmptyState";
import { Button } from "@/components/ui/Button";
import { trackPageView } from "@/lib/analytics/track";

export const metadata: Metadata = { title: "Votar" };
export const dynamic = "force-dynamic";

export default async function VotarPage() {
  trackPageView("/votar");
  // Pode ser a eleição geral OU uma votação de desempate: quem decide é o
  // Postgres, pelo status autoritativo.
  const active = await getCurrentVotingElection();

  if (!active) {
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

  const isRunoff = active.type === "runoff";

  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      {isRunoff && (
        <p className="mb-5 rounded-md border border-warning bg-warning-bg px-3.5 py-3 text-center text-sm text-warning">
          Esta é uma <strong>votação de desempate</strong>. Mesmo que você já tenha votado na
          eleição, seu voto aqui é necessário para definir a(s) vaga(s) empatada(s).
        </p>
      )}
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
