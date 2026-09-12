import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type RateLimitScope = "voter_validate" | "admin_login";

const SCOPE_CONFIG: Record<RateLimitScope, { windowSeconds: number; maxAttempts: number; blockSeconds: number }> = {
  // Seção 24: eleitores podem compartilhar a rede da universidade — limites
  // progressivos, nunca bloqueio definitivo só por IP.
  voter_validate: { windowSeconds: 300, maxAttempts: 8, blockSeconds: 60 },
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
