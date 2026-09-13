import { ELECTION_STATUSES, type ElectionStatus } from "@/lib/election/status-values";

/**
 * Forma do estado ao vivo e sua validação — uma definição só, usada pelo
 * produtor (servidor, ao ler o RPC) e pelo consumidor (cliente, ao receber
 * a resposta do polling). Duas cópias divergiriam no primeiro campo novo.
 */
export type LiveState = {
  status: ElectionStatus;
  /** null fora da votação — regra do Postgres (seção 47), não omissão. */
  participation: number | null;
  /** Hora do servidor. DISPLAY ONLY: nada autoriza voto por hora do cliente. */
  serverTime: string;
  votingOpen: boolean;
};

export function isElectionStatus(value: unknown): value is ElectionStatus {
  return typeof value === "string" && (ELECTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Guarda do payload recebido pelo polling. Rejeitar em vez de renderizar
 * é deliberado: o componente mantém o último valor bom, e um status
 * desconhecido chegando na tela quebraria o mapa de rótulos/cores.
 */
export function isLiveState(value: unknown): value is LiveState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isElectionStatus(candidate.status) &&
    (candidate.participation === null || typeof candidate.participation === "number") &&
    typeof candidate.serverTime === "string" &&
    typeof candidate.votingOpen === "boolean"
  );
}
