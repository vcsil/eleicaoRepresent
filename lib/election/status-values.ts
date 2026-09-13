/**
 * Vocabulário de status — sem `server-only`, porque o badge e o countdown
 * ao vivo rodam no cliente e precisam dos rótulos e do predicado de
 * votação. Aqui não há nada sensível: são constantes de apresentação.
 *
 * O CÁLCULO do status continua exclusivamente no Postgres
 * (`compute_election_status`), consultado pelo servidor a cada requisição.
 * Nada neste arquivo decide nada.
 */

/** Espelha o enum retornado por compute_election_status() no Postgres. */
export const ELECTION_STATUSES = [
  "nao_iniciada",
  "candidaturas_abertas",
  "candidaturas_encerradas",
  "candidatos_divulgados",
  "apresentacao",
  "aguardando_votacao",
  "votacao_em_andamento",
  "votacao_encerrada",
  "em_apuracao",
  "aguardando_divulgacao",
  "resultado_disponivel",
  "desempate_necessario",
  "votacao_desempate",
] as const;

export type ElectionStatus = (typeof ELECTION_STATUSES)[number];

export const ELECTION_STATUS_LABELS: Record<ElectionStatus, string> = {
  nao_iniciada: "Eleição ainda não iniciada",
  candidaturas_abertas: "Candidaturas abertas",
  candidaturas_encerradas: "Candidaturas encerradas",
  candidatos_divulgados: "Candidatos divulgados",
  apresentacao: "Apresentação dos candidatos",
  aguardando_votacao: "Aguardando votação",
  votacao_em_andamento: "Votação em andamento",
  votacao_encerrada: "Votação encerrada",
  em_apuracao: "Em apuração",
  aguardando_divulgacao: "Aguardando divulgação",
  resultado_disponivel: "Resultado disponível",
  desempate_necessario: "Desempate necessário",
  votacao_desempate: "Votação de desempate",
};

export const VOTING_STATUSES: ElectionStatus[] = ["votacao_em_andamento", "votacao_desempate"];

/**
 * Predicado de apresentação: decide o que a tela MOSTRA, nunca se um voto
 * é aceito. A urna é autorizada no servidor, por validate_voter/cast_ballot.
 */
export function isVotingOpen(status: ElectionStatus): boolean {
  return VOTING_STATUSES.includes(status);
}
