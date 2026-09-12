import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

/**
 * Cliente com a chave service_role — ignora RLS. Só pode ser usado em
 * Server Actions/Route Handlers, nunca em Server Components que apenas
 * exibem dados, e jamais enviado ao navegador (seção 74 do documento
 * técnico). Toda regra de negócio ainda deve ser validada explicitamente
 * no código que usa este cliente ou nas funções SECURITY DEFINER do banco.
 */
export function createServiceClient() {
  const env = getServerEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}
