/**
 * Por que uma vaga ficou sem ocupante.
 *
 * Sem `server-only`: é aritmética e vocabulário de apresentação, sem
 * acesso a dado nenhum. Vive separado das duas telas porque as duas
 * precisam da MESMA resposta — o resultado público e a revisão interna não
 * podem divergir sobre o motivo de uma vaga estar vazia.
 *
 * A regra central: `vagas − eleitos` diz QUANTAS vagas faltam, nunca POR
 * QUÊ. Dois candidatos empatados para uma vaga, um cargo esvaziado por
 * decisão de cargo duplo e um cargo sem candidatura nenhuma produzem
 * exatamente a mesma diferença. Atribuir a causa pela subtração era
 * anunciar "sem candidato" em eleição que teve candidato.
 */
export type SeatGapReason = "sem_candidatura" | "aguardando_desempate" | "cargo_duplo";

export type SeatGap = { reason: SeatGapReason; seats: number };

export type SeatGapInput = {
  vacancies: number | null;
  electedCount: number;
  /** Vagas esvaziadas por decisão de cargo duplo sem ninguém para promover. */
  vacatedByDualWinner: number;
  /** Vagas em desempate ainda não resolvido (0 quando não há desempate aberto). */
  seatsInRunoff: number;
  /** Há linha marcada com `tie_break_needed` mas nenhum desempate criado ainda. */
  hasPendingTie: boolean;
};

/**
 * As causas são atribuídas na ordem em que são CONHECIDAS, e cada vaga
 * conta uma vez só: primeiro o que tem registro próprio (cargo duplo,
 * desempate), e só o resto — aquilo para o qual não existe outra
 * explicação — vira falta de candidatura.
 */
export function computeSeatGaps(input: SeatGapInput): SeatGap[] {
  if (input.vacancies === null) return [];

  const faltando = Math.max(input.vacancies - input.electedCount, 0);
  if (faltando === 0) return [];

  const cargoDuplo = Math.min(Math.max(input.vacatedByDualWinner, 0), faltando);
  const restante = faltando - cargoDuplo;

  // Com desempate já criado, o número de vagas vem dele. Com empate
  // apurado mas desempate ainda não aberto, todas as vagas restantes estão
  // pendentes — não há outra explicação possível para elas.
  const emDesempate = Math.min(
    input.seatsInRunoff > 0 ? input.seatsInRunoff : input.hasPendingTie ? restante : 0,
    restante,
  );

  const semCandidatura = restante - emDesempate;

  const gaps: SeatGap[] = [];
  if (emDesempate > 0) gaps.push({ reason: "aguardando_desempate", seats: emDesempate });
  if (cargoDuplo > 0) gaps.push({ reason: "cargo_duplo", seats: cargoDuplo });
  if (semCandidatura > 0) gaps.push({ reason: "sem_candidatura", seats: semCandidatura });
  return gaps;
}

/** Texto para a revisão administrativa. */
export function seatGapLabel(reason: SeatGapReason, seats: number): string {
  const vagas = `${seats} ${seats === 1 ? "vaga" : "vagas"}`;
  if (reason === "aguardando_desempate") {
    return `${vagas} ${seats === 1 ? "aguarda" : "aguardam"} a resolução do desempate.`;
  }
  if (reason === "cargo_duplo") {
    return `${vagas} ${seats === 1 ? "ficou desocupada" : "ficaram desocupadas"} após a decisão de cargo duplo, sem candidato remanescente para promover.`;
  }
  return `${vagas} sem preenchimento: não houve candidatura suficiente.`;
}

/**
 * Texto para o resultado público. Só é exibido depois da publicação, e
 * `publish_results` exige empate resolvido — mas a causa continua sendo
 * lida do registro, não deduzida, para o caso de um desempate resolvido
 * por decisão administrativa deixar vaga em aberto.
 */
export function publicSeatGapLabel(reason: SeatGapReason, seats: number): string {
  const vagas = `${seats} ${seats === 1 ? "vaga" : "vagas"}`;
  if (reason === "aguardando_desempate") {
    return `${vagas} ${seats === 1 ? "permanece" : "permanecem"} em aberto após o desempate.`;
  }
  if (reason === "cargo_duplo") {
    return `${vagas} ${seats === 1 ? "ficou desocupada" : "ficaram desocupadas"} porque o candidato eleito assumiu outro cargo e não havia candidato remanescente.`;
  }
  return `${vagas} ${seats === 1 ? "não foi preenchida" : "não foram preenchidas"} por falta de candidaturas.`;
}
