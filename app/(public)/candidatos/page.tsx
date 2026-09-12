import type { Metadata } from "next";
import { getActiveCandidates } from "@/lib/election/candidates";
import { getActivePositions } from "@/lib/election/positions";
import { CandidatesExplorer } from "@/components/candidates/CandidatesExplorer";
import { EmptyState } from "@/components/feedback/EmptyState";
import { trackPageView } from "@/lib/analytics/track";

export const metadata: Metadata = { title: "Candidatos" };
export const dynamic = "force-dynamic";

export default async function CandidatosPage() {
  trackPageView("/candidatos");
  const [candidates, positions] = await Promise.all([
    getActiveCandidates(),
    getActivePositions(),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <header className="mb-10 text-center">
        <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">Candidatos</h1>
        <p className="mx-auto mt-3 max-w-2xl text-foreground-muted">
          Conheça quem está concorrendo a cada cargo da Comissão de Formatura. Toque em um
          candidato para ver apresentação, propostas e vídeo.
        </p>
      </header>

      {candidates.length === 0 ? (
        <EmptyState
          title="Nenhum candidato divulgado ainda"
          description="As candidaturas aparecerão aqui assim que forem divulgadas pela administração."
        />
      ) : (
        <CandidatesExplorer candidates={candidates} positions={positions} />
      )}
    </div>
  );
}
