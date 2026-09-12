import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

/**
 * Cliente com a chave anônima, sujeito a RLS. Usado em Server Components
 * para leituras públicas (cargos, candidatos ativos, cronograma, status,
 * resultados já publicados). Nunca usado para operações sensíveis.
 */
export function createAnonClient() {
  const env = getServerEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
}
