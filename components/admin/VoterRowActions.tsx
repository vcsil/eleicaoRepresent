"use client";

import { useState, useTransition } from "react";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";
import {
  deleteVoterAction,
  setVoterActiveAction,
  type VoterMutationState,
} from "@/app/admin/(protected)/eleitores/actions";
import type { AdminVoter } from "@/lib/admin/voters-values";

const inicial: VoterMutationState = { error: null };

/**
 * Ações por eleitor: inativar/ativar e excluir.
 *
 * `votingOpen` só controla o TEXTO do diálogo e o envio da confirmação
 * extra — as Server Actions revalidam o status por conta própria antes de
 * gravar, porque um botão não autoriza nada.
 */
export function VoterRowActions({ voter, votingOpen }: { voter: AdminVoter; votingOpen: boolean }) {
  const [aberto, setAberto] = useState<"delete" | "toggle" | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function executar(acao: "delete" | "toggle") {
    startTransition(async () => {
      setErro(null);
      const formData = new FormData();
      formData.set("voter_id", voter.id);
      if (votingOpen) formData.set("confirm_voting_open", "1");

      let resultado: VoterMutationState;
      if (acao === "delete") {
        resultado = await deleteVoterAction(inicial, formData);
      } else {
        formData.set("active", voter.active ? "0" : "1");
        resultado = await setVoterActiveAction(inicial, formData);
      }
      if (resultado.error) setErro(resultado.error);
      setAberto(null);
    });
  }

  const alvo = `${voter.full_name} (matrícula ${voter.registration_number})`;
  const avisoVotacao = votingOpen
    ? " A votação está ABERTA: isso altera o total de eleitores habilitados e o percentual de participação do pleito em curso."
    : "";

  return (
    <div className="flex items-center justify-end gap-1">
      <button
        type="button"
        onClick={() => setAberto("toggle")}
        disabled={isPending}
        aria-label={`${voter.active ? "Inativar" : "Ativar"} ${voter.full_name}`}
        className="rounded-md px-2 py-1 text-xs font-medium text-foreground-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {voter.active ? "Inativar" : "Ativar"}
      </button>
      <button
        type="button"
        onClick={() => setAberto("delete")}
        disabled={isPending}
        aria-label={`Excluir ${voter.full_name}`}
        className="rounded-md p-1.5 text-danger hover:bg-danger-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {erro && (
        <p role="alert" className="ml-2 text-xs text-danger">
          {erro}
        </p>
      )}

      <ConfirmationDialog
        open={aberto === "delete"}
        title="Excluir eleitor?"
        description={`Tem certeza de que deseja excluir ${alvo}? Esta ação não pode ser desfeita. Um eleitor que já registrou voto não pode ser excluído — nesse caso, inative o cadastro.${avisoVotacao}`}
        confirmLabel="Excluir eleitor"
        confirming={isPending}
        onCancel={() => setAberto(null)}
        onConfirm={() => executar("delete")}
      />

      <ConfirmationDialog
        open={aberto === "toggle"}
        title={voter.active ? "Inativar eleitor?" : "Ativar eleitor?"}
        description={
          voter.active
            ? `${alvo} deixará de poder votar e sai da contagem de habilitados. O histórico dele é preservado.${avisoVotacao}`
            : `${alvo} volta a poder votar e entra na contagem de habilitados.${avisoVotacao}`
        }
        confirmLabel={voter.active ? "Inativar" : "Ativar"}
        confirming={isPending}
        onCancel={() => setAberto(null)}
        onConfirm={() => executar("toggle")}
      />
    </div>
  );
}
