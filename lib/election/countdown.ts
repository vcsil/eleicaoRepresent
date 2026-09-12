import "server-only";
import type { ElectionStatus } from "@/lib/election/status";
import { getPhaseBounds, type ElectionPhase, type ElectionPhaseKey } from "@/lib/election/phases";

function bound(phases: ElectionPhase[], key: ElectionPhaseKey, edge: "starts" | "ends") {
  const phase = phases.find((p) => p.phase_key === key);
  if (!phase) return null;
  const { startsAt, endsAt } = getPhaseBounds(phase);
  return (edge === "starts" ? startsAt : endsAt).toISOString();
}

/**
 * Cronômetro contextual (seção 6): muda automaticamente de acordo com a
 * fase atual. Retorna null quando não faz sentido mostrar contagem.
 */
export function getCountdownConfig(
  status: ElectionStatus,
  phases: ElectionPhase[],
): { label: string; targetIso: string } | null {
  switch (status) {
    case "nao_iniciada": {
      const target = bound(phases, "edital", "starts");
      return target ? { label: "Publicação do edital em", targetIso: target } : null;
    }
    case "candidaturas_abertas": {
      const target = bound(phases, "candidaturas", "ends");
      return target ? { label: "Encerramento das candidaturas em", targetIso: target } : null;
    }
    case "candidaturas_encerradas": {
      const target = bound(phases, "divulgacao_candidaturas", "starts");
      return target ? { label: "Divulgação dos candidatos em", targetIso: target } : null;
    }
    case "candidatos_divulgados": {
      const target = bound(phases, "apresentacao", "starts");
      return target ? { label: "Apresentação dos candidatos em", targetIso: target } : null;
    }
    case "apresentacao":
    case "aguardando_votacao": {
      const target = bound(phases, "votacao", "starts");
      return target ? { label: "Início da votação em", targetIso: target } : null;
    }
    case "votacao_em_andamento": {
      const target = bound(phases, "votacao", "ends");
      return target ? { label: "Votação encerra em", targetIso: target } : null;
    }
    case "votacao_desempate": {
      const target = bound(phases, "votacao", "ends");
      return target ? { label: "Votação de desempate encerra em", targetIso: target } : null;
    }
    case "votacao_encerrada":
    case "em_apuracao": {
      const target = bound(phases, "divulgacao_resultados", "starts");
      return target ? { label: "Resultado previsto em", targetIso: target } : null;
    }
    default:
      return null;
  }
}
