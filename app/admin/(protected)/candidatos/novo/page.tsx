import type { Metadata } from "next";
import { getActivePositions } from "@/lib/election/positions";
import { electionIsFrozen } from "@/lib/election/composition-freeze";
import { CandidateForm } from "@/components/admin/CandidateForm";
import { EmptyState } from "@/components/feedback/EmptyState";
import { Button } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Novo candidato — Administração" };
export const dynamic = "force-dynamic";

export default async function NovoCandidatoPage() {
  const [positions, frozen] = await Promise.all([getActivePositions(), electionIsFrozen()]);

  // A criação some da tela depois da liberação; a recusa de verdade está em
  // `upsertCandidateAction`, que rejeita o POST mesmo se esta página for
  // acessada direto pela URL.
  if (frozen) {
    return (
      <div className="max-w-xl">
        <EmptyState
          title="Composição congelada"
          description="A composição eleitoral está bloqueada porque a votação já foi liberada: não é possível cadastrar novos candidatos."
          action={<Button href="/admin/candidatos">Voltar aos candidatos</Button>}
        />
      </div>
    );
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold text-foreground">Adicionar candidato</h1>
      <div className="mt-6">
        <CandidateForm candidate={null} positions={positions} />
      </div>
    </div>
  );
}
