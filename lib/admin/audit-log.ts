import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Registra uma ação administrativa. Como ainda não há contas individuais
 * (seção 58), toda ação é atribuída a "admin_session" até a futura
 * migração para Supabase Auth (seção 62).
 */
export async function logAdminAction(
  action: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from("admin_logs").insert({
    action,
    actor: "admin_session",
    metadata,
  });
  if (error) {
    console.error("failed to log admin action", error);
  }
}
