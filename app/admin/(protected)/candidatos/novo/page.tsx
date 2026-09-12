import type { Metadata } from "next";
import { getActivePositions } from "@/lib/election/positions";
import { CandidateForm } from "@/components/admin/CandidateForm";

export const metadata: Metadata = { title: "Novo candidato — Administração" };
export const dynamic = "force-dynamic";

export default async function NovoCandidatoPage() {
  const positions = await getActivePositions();

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold text-foreground">Adicionar candidato</h1>
      <div className="mt-6">
        <CandidateForm candidate={null} positions={positions} />
      </div>
    </div>
  );
}
