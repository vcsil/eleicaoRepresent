// Sem `server-only`: o countdown ao vivo recalcula o alvo no cliente
// quando o status muda (votação abre/encerra) sem recarregar a página.
import type { ElectionStatus } from "@/lib/election/status";
import {
  getPhaseBounds,
  type ElectionPhase,
  type ElectionPhaseKey,
} from "@/lib/election/phase-bounds";

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

export type CountdownRemaining = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  done: boolean;
};

/**
 * Tempo restante até `targetIso`, a partir de um instante EXPLÍCITO.
 *
 * Receber `nowMs` em vez de ler `Date.now()` é o que torna esta função
 * determinística — e é a correção do hydration mismatch: servidor e
 * cliente calculam o primeiro render a partir do mesmo instante (a hora do
 * servidor), produzindo markup idêntico. Antes, cada lado lia o próprio
 * relógio e os segundos divergiam pelo tempo de rede + hidratação.
 */
export function getRemaining(targetIso: string, nowMs: number): CountdownRemaining {
  const diff = Math.max(0, new Date(targetIso).getTime() - nowMs);
  const totalSeconds = Math.floor(diff / 1000);
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    done: diff === 0,
  };
}
