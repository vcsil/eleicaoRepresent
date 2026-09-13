"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { voterValidationSchema } from "@/lib/validation/schemas";
import { createServiceClient } from "@/lib/supabase/service";
import { getMainElection } from "@/lib/election/status";
import {
  clearVoteConfirmedCookie,
  setVoteSessionCookie,
  VOTE_SESSION_TTL_SECONDS,
} from "@/lib/election/vote-session";
import { getClientIp, summarizeUserAgent } from "@/lib/security/ip";
import { hashIp, hashKey } from "@/lib/security/hashing";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { logSecurityEvent } from "@/lib/security/security-events";

const GENERIC_ERROR = "Não foi possível validar os dados informados.";

export type ValidateVoterState = { error: string | null };

export async function validateVoterAction(
  _prevState: ValidateVoterState,
  formData: FormData,
): Promise<ValidateVoterState> {
  const parsed = voterValidationSchema.safeParse({
    registration_number: formData.get("registration_number"),
    full_name: formData.get("full_name"),
  });

  if (!parsed.success) {
    return { error: GENERIC_ERROR };
  }

  const headerList = await headers();
  const ip = getClientIp(headerList);
  const ipHash = hashIp(ip);
  const userAgentSummary = summarizeUserAgent(headerList.get("user-agent"));
  const registrationHash = hashKey(parsed.data.registration_number.toLowerCase());

  // Os dois limites são independentes (um por IP, um por matrícula) e
  // ambos são sempre avaliados — o segundo não depende do resultado do
  // primeiro. Em série, custavam dois round trips; em paralelo, um.
  // Contar as duas tentativas mesmo quando uma já estourou é deliberado:
  // é assim que o contador por matrícula registra a tentativa de quem
  // troca de IP, e vice-versa.
  const [allowedByIp, allowedByRegistration] = await Promise.all([
    checkRateLimit("voter_validate_ip", ipHash),
    checkRateLimit("voter_validate_registration", registrationHash),
  ]);

  if (!allowedByIp || !allowedByRegistration) {
    await logSecurityEvent({
      type: "RATE_LIMIT_TRIGGERED",
      severity: "warning",
      ipHash,
      userAgentSummary,
      route: "/votar",
    });
    return { error: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente." };
  }

  const election = await getMainElection();
  if (!election) {
    return { error: GENERIC_ERROR };
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("validate_voter", {
    p_election_id: election.id,
    p_registration_number: parsed.data.registration_number,
    p_full_name: parsed.data.full_name,
    p_ip_hash: ipHash,
    p_user_agent_summary: userAgentSummary,
    p_session_ttl_seconds: VOTE_SESSION_TTL_SECONDS,
  });

  if (error) {
    console.error("validate_voter failed", error);
    return { error: GENERIC_ERROR };
  }

  const result = data as { status: string; token?: string; expires_at?: string };

  if (result.status === "already_voted") {
    await logSecurityEvent({
      type: "DUPLICATE_VOTE_ATTEMPT",
      severity: "info",
      ipHash,
      userAgentSummary,
      route: "/votar",
    });
    return { error: "Esta matrícula já registrou um voto nesta eleição." };
  }

  if (result.status === "voting_not_open") {
    return { error: "A votação não está aberta no momento." };
  }

  if (result.status !== "ok" || !result.token || !result.expires_at) {
    await logSecurityEvent({
      type: "INVALID_VOTER_VALIDATION",
      severity: "info",
      ipHash,
      userAgentSummary,
      route: "/votar",
    });
    return { error: GENERIC_ERROR };
  }

  // Dispositivo compartilhado: apaga a confirmação de quem votou antes,
  // para o eleitor atual não encontrar "seu voto foi registrado" antes de
  // ter votado. Aqui é permitido — estamos numa Server Action.
  await clearVoteConfirmedCookie();
  await setVoteSessionCookie(result.token, new Date(result.expires_at));
  redirect("/votar/urna");
}
