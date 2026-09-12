import type { Metadata } from "next";
import Image from "next/image";
import { listAllCandidates } from "@/lib/admin/candidates";
import { getActivePositions } from "@/lib/election/positions";
import { setCandidateActiveAction } from "./actions";
import { candidatePhotoUrl } from "@/lib/media/candidate-photo";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/feedback/EmptyState";

export const metadata: Metadata = { title: "Candidatos — Administração" };
export const dynamic = "force-dynamic";

export default async function AdminCandidatosPage() {
  const [candidates, positions] = await Promise.all([listAllCandidates(), getActivePositions()]);
  const positionName = (id: string) => positions.find((p) => p.id === id)?.name ?? "—";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-foreground">Candidatos</h1>
        <Button href="/admin/candidatos/novo">Adicionar candidato</Button>
      </div>

      {candidates.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="Nenhum candidato cadastrado" />
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {candidates.map((candidate) => {
            const photoUrl = candidatePhotoUrl(candidate.photo_path);
            return (
              <Card key={candidate.id} className="flex flex-wrap items-center gap-4 p-4">
                {photoUrl ? (
                  <Image
                    src={photoUrl}
                    alt=""
                    width={48}
                    height={48}
                    className="h-12 w-12 rounded-full object-cover"
                  />
                ) : (
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-foreground-muted">
                    ?
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{candidate.full_name}</p>
                  <p className="text-xs text-foreground-muted">
                    {candidate.position_ids.map(positionName).join(" e ") || "Sem cargo definido"}
                  </p>
                </div>

                <Badge tone={candidate.active ? "success" : "neutral"}>
                  {candidate.active ? "Ativo" : "Inativo"}
                </Badge>

                <div className="flex items-center gap-2">
                  <Button href={`/admin/candidatos/${candidate.id}`} variant="secondary" size="md">
                    Editar
                  </Button>
                  <form action={setCandidateActiveAction.bind(null, candidate.id, !candidate.active)}>
                    <Button type="submit" variant="ghost" size="md">
                      {candidate.active ? "Desativar" : "Reativar"}
                    </Button>
                  </form>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
