"use server";

import { headers } from "next/headers";
import { ballotSubmitSchema } from "@/lib/validation/schemas";
import { createServiceClient } from "@/lib/supabase/service";
import { getVoteSessionToken, clearVoteSessionCookie, setVoteConfirmedCookie } from "@/lib/election/vote-session";
import { getClientIp, summarizeUserAgent } from "@/lib/security/ip";
import { hashIp } from "@/lib/security/hashing";
import { logSecurityEvent } from "@/lib/security/security-events";
import type { BallotSubmitPayload } from "@/lib/vote/draft";

const GENERIC_ERROR = "Não foi possível registrar seu voto. Tente novamente.";

const ERROR_MESSAGES: Record<string, string> = {
  SESSION_INVALID: "Sua sessão de votação expirou. Valide seus dados novamente.",
  SESSION_EXPIRED: "Sua sessão de votação expirou. Valide seus dados novamente.",
  VOTER_INACTIVE: "Não foi possível registrar seu voto.",
  VOTING_CLOSED: "O período de votação foi encerrado.",
  ALREADY_VOTED: "Esta matrícula já registrou um voto nesta eleição.",
  INVALID_PAYLOAD: "Distribuição de votos inválida. Revise e tente novamente.",
  INVALID_CANDIDATE: "Distribuição de votos inválida. Revise e tente novamente.",
  INVALID_VOTE_SUM: "A quantidade de votos distribuídos não confere. Revise e tente novamente.",
};

export type SubmitBallotState = { success: boolean; error: string | null };

export async function submitBallotAction(payload: BallotSubmitPayload): Promise<SubmitBallotState> {
  const parsed = ballotSubmitSchema.safeParse(payload);

  const headerList = await headers();
  const ipHash = hashIp(getClientIp(headerList));
  const userAgentSummary = summarizeUserAgent(headerList.get("user-agent"));

  if (!parsed.success) {
    await logSecurityEvent({
      type: "INVALID_VOTE_PAYLOAD",
      severity: "warning",
      ipHash,
      userAgentSummary,
      route: "/votar/revisao",
    });
    return { success: false, error: GENERIC_ERROR };
  }

  const token = await getVoteSessionToken();
  if (!token) {
    return { success: false, error: ERROR_MESSAGES.SESSION_INVALID };
  }

  const supabase = createServiceClient();
  const { error } = await supabase.rpc("cast_ballot", {
    p_session_token: token,
    p_payload: parsed.data,
  });

  if (error) {
    const code = error.message.trim();
    if (code === "ALREADY_VOTED") {
      await logSecurityEvent({
        type: "DUPLICATE_VOTE_ATTEMPT",
        severity: "warning",
        ipHash,
        userAgentSummary,
        route: "/votar/revisao",
      });
    } else if (code === "INVALID_PAYLOAD" || code === "INVALID_CANDIDATE" || code === "INVALID_VOTE_SUM") {
      await logSecurityEvent({
        type: "INVALID_VOTE_PAYLOAD",
        severity: "warning",
        ipHash,
        userAgentSummary,
        route: "/votar/revisao",
        metadata: { code },
      });
    } else {
      console.error("cast_ballot failed", error);
    }

    if (code === "SESSION_INVALID" || code === "SESSION_EXPIRED" || code === "VOTING_CLOSED" || code === "ALREADY_VOTED") {
      await clearVoteSessionCookie();
    }

    return { success: false, error: ERROR_MESSAGES[code] ?? GENERIC_ERROR };
  }

  await setVoteConfirmedCookie();
  await clearVoteSessionCookie();

  return { success: true, error: null };
}
