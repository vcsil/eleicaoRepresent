"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";
import { LoadingState } from "@/components/feedback/LoadingState";
import {
  NULL_OPTION_KEY,
  draftToPayload,
  getPositionTotal,
  type BallotDraft,
} from "@/lib/vote/draft";
import type { WizardPosition, WizardCandidate } from "@/lib/election/ballot-options";
import { submitBallotAction } from "@/app/(public)/votar/revisao/actions";

function subscribeNoop() {
  return () => {};
}

function makeDraftSnapshotGetter(draftKey: string) {
  return () => {
    try {
      return window.sessionStorage.getItem(draftKey);
    } catch {
      return null;
    }
  };
}

function getServerDraftSnapshot(): string | null {
  return null;
}

export function VoteReview({
  positions,
  candidatesByPosition,
  draftKey,
}: {
  positions: WizardPosition[];
  candidatesByPosition: Record<string, WizardCandidate[]>;
  /** Chave do rascunho, derivada da sessão de voto pelo servidor. */
  draftKey: string;
}) {
  const router = useRouter();
  const getDraftSnapshot = useMemo(() => makeDraftSnapshotGetter(draftKey), [draftKey]);
  const rawDraft = useSyncExternalStore(subscribeNoop, getDraftSnapshot, getServerDraftSnapshot);
  const hydrated = typeof window !== "undefined";
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  let draft: BallotDraft | null = null;
  try {
    draft = rawDraft ? (JSON.parse(rawDraft) as BallotDraft) : null;
  } catch {
    draft = null;
  }

  const complete =
    draft !== null && positions.every((p) => getPositionTotal(draft!, p.id) === p.votes_per_voter);

  useEffect(() => {
    if (hydrated && !complete) {
      router.replace("/votar/urna");
    }
  }, [hydrated, complete, router]);

  if (!hydrated || !draft || !complete) {
    return <LoadingState label="Carregando sua distribuição de votos..." />;
  }

  function resolveName(positionId: string, key: string): string {
    if (key === NULL_OPTION_KEY) return "Nulo";
    const candidate = candidatesByPosition[positionId]?.find((c) => c.id === key);
    return candidate?.full_name ?? "Candidato";
  }

  function handleConfirm() {
    startTransition(async () => {
      setError(null);
      const result = await submitBallotAction(draftToPayload(draft!));
      if (result.success) {
        try {
          window.sessionStorage.removeItem(draftKey);
        } catch {
          // sessionStorage indisponível: o voto já foi registrado, seguir.
        }
        router.push("/voto-confirmado");
      } else {
        setError(result.error);
        setConfirmOpen(false);
      }
    });
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-foreground">Revise seus votos</h1>
      <p className="mt-2 text-sm text-foreground-muted">
        Confira a distribuição antes de confirmar. Você pode alterar qualquer cargo antes do envio
        definitivo.
      </p>

      <div className="mt-6 space-y-4">
        {positions.map((position) => {
          const allocations = Object.entries(draft[position.id] ?? {}).filter(([, qty]) => qty > 0);
          const stepIndex = positions.findIndex((p) => p.id === position.id);
          return (
            <Card key={position.id} className="p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-medium text-foreground">{position.name}</h2>
                <Link
                  href={`/votar/urna?step=${stepIndex}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Alterar
                </Link>
              </div>
              <ul className="mt-3 space-y-1 text-sm text-foreground-muted">
                {allocations.map(([key, qty]) => (
                  <li key={key} className="flex justify-between">
                    <span>{resolveName(position.id, key)}</span>
                    <span className="font-medium text-foreground">
                      {qty} {qty === 1 ? "voto" : "votos"}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="mt-6 rounded-md bg-danger-bg px-3.5 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mt-8 rounded-lg border border-warning bg-warning-bg p-4 text-sm text-warning">
        Após confirmar, seu voto será registrado definitivamente e não poderá ser alterado.
      </div>

      <div className="mt-6 flex justify-end">
        <Button type="button" size="lg" onClick={() => setConfirmOpen(true)}>
          Confirmar voto
        </Button>
      </div>

      <ConfirmationDialog
        open={confirmOpen}
        title="Confirmar votação"
        description="Tem certeza de que deseja registrar definitivamente seus votos? Esta ação não pode ser desfeita."
        confirmLabel="Sim, registrar meu voto"
        confirming={isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
