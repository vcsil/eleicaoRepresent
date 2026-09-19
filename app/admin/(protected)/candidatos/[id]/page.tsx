import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCandidateById } from "@/lib/admin/candidates";
import { getActivePositions } from "@/lib/election/positions";
import { electionIsFrozen } from "@/lib/election/composition-freeze";
import { CandidateForm } from "@/components/admin/CandidateForm";

export const metadata: Metadata = { title: "Editar candidato — Administração" };
export const dynamic = "force-dynamic";

export default async function EditarCandidatoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [candidate, positions, frozen] = await Promise.all([
    getCandidateById(id),
    getActivePositions(),
    electionIsFrozen(),
  ]);

  if (!candidate) {
    notFound();
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold text-foreground">Editar candidato</h1>
      <div className="mt-6">
        <CandidateForm candidate={candidate} positions={positions} frozen={frozen} />
      </div>
    </div>
  );
}
