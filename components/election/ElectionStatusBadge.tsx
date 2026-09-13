import { Badge } from "@/components/ui/Badge";
import { ELECTION_STATUS_LABELS, type ElectionStatus } from "@/lib/election/status-values";

const TONE_BY_STATUS: Record<ElectionStatus, "neutral" | "success" | "warning" | "info" | "accent"> = {
  nao_iniciada: "neutral",
  candidaturas_abertas: "info",
  candidaturas_encerradas: "neutral",
  candidatos_divulgados: "info",
  apresentacao: "info",
  aguardando_votacao: "accent",
  votacao_em_andamento: "success",
  votacao_encerrada: "neutral",
  em_apuracao: "warning",
  aguardando_divulgacao: "warning",
  resultado_disponivel: "success",
  desempate_necessario: "warning",
  votacao_desempate: "success",
};

export function ElectionStatusBadge({ status }: { status: ElectionStatus }) {
  return <Badge tone={TONE_BY_STATUS[status]}>{ELECTION_STATUS_LABELS[status]}</Badge>;
}
