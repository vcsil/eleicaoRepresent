"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";
import { closeVotingAction, computeResultsAction } from "@/app/admin/(protected)/votacao/actions";
import { isVotingOpen, type ElectionStatus } from "@/lib/election/status-values";

export function ElectionControlPanel({
  electionId,
  status,
}: {
  electionId: string;
  status: ElectionStatus;
}) {
  const [pendingAction, setPendingAction] = useState<"close" | "compute" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Usa o predicado do projeto em vez de comparar strings: vale para a
  // eleição geral (`votacao_em_andamento`) e para o desempate
  // (`votacao_desempate`), sem duplicar o vocabulário.
  const canClose = isVotingOpen(status);
  // Um desempate nunca passa por `votacao_encerrada`: o ciclo dele é
  // votacao_desempate -> em_apuracao -> aguardando_divulgacao
  // (compute_election_status, migration 0010). `em_apuracao` já cobre os dois.
  const canCompute = status === "votacao_encerrada" || status === "em_apuracao";

  function run(action: "close" | "compute") {
    startTransition(async () => {
      setError(null);
      const formData = new FormData();
      formData.set("election_id", electionId);
      const result =
        action === "close"
          ? await closeVotingAction({ error: null }, formData)
          : await computeResultsAction({ error: null }, formData);
      if (result.error) setError(result.error);
      setPendingAction(null);
    });
  }

  return (
    <div className="flex flex-wrap gap-3">
      <Button type="button" disabled={!canClose} onClick={() => setPendingAction("close")}>
        Encerrar votação
      </Button>
      <Button
        type="button"
        variant="secondary"
        disabled={!canCompute}
        onClick={() => setPendingAction("compute")}
      >
        Iniciar apuração
      </Button>

      {error && <p className="w-full text-sm text-danger">{error}</p>}

      <ConfirmationDialog
        open={pendingAction === "close"}
        title="Encerrar votação"
        description="Tem certeza de que deseja encerrar a votação agora? Ninguém mais poderá votar depois disso."
        confirmLabel="Encerrar votação"
        confirming={isPending}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => run("close")}
      />

      <ConfirmationDialog
        open={pendingAction === "compute"}
        title="Iniciar apuração"
        description="Isso calcula os resultados a partir dos votos registrados. Os resultados não se tornam públicos automaticamente — a publicação continua sendo uma etapa separada."
        confirmLabel="Iniciar apuração"
        confirming={isPending}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => run("compute")}
      />
    </div>
  );
}
