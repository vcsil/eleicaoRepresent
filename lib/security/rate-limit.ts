import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type RateLimitScope =
  | "voter_validate_ip"
  | "voter_validate_registration"
  | "admin_login";

/**
 * As duas dimensões da validação do eleitor têm tetos DIFERENTES porque
 * medem coisas diferentes (seção 24).
 *
 * Por IP: a turma inteira costuma sair pelo mesmo IP público (wi-fi da
 * faculdade, NAT). Um teto baixo aqui não barra atacante nenhum — barra
 * eleitores legítimos votando em sequência, e o bloqueio ainda escala a
 * cada nova tentativa. Vale só como contenção de abuso grosseiro.
 *
 * Por matrícula: este é o controle anti-força-bruta que importa. É ele que
 * impede alguém de ficar tentando adivinhar o nome completo associado a
 * uma matrícula específica. Continua estrito.
 */
const SCOPE_CONFIG: Record<RateLimitScope, { windowSeconds: number; maxAttempts: number; blockSeconds: number }> = {
  voter_validate_ip: { windowSeconds: 300, maxAttempts: 100, blockSeconds: 60 },
  voter_validate_registration: { windowSeconds: 300, maxAttempts: 10, blockSeconds: 60 },
  // Seção 61: login administrativo é alvo mais sensível a força bruta.
  admin_login: { windowSeconds: 300, maxAttempts: 5, blockSeconds: 120 },
};

/** true = tentativa permitida, false = bloqueada temporariamente. */
export async function checkRateLimit(scope: RateLimitScope, keyHash: string): Promise<boolean> {
  const config = SCOPE_CONFIG[scope];
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("check_and_increment_rate_limit", {
    p_scope: scope,
    p_key_hash: keyHash,
    p_window_seconds: config.windowSeconds,
    p_max_attempts: config.maxAttempts,
    p_block_seconds: config.blockSeconds,
  });

  if (error) {
    // Falha ao checar rate limit não deve travar o fluxo, mas deve ser
    // tratada como suspeita — o chamador decide se prossegue com cautela.
    console.error("rate limit check failed", error);
    return true;
  }

  return Boolean(data);
}
