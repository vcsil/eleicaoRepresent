import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type SecurityEventType =
  | "INVALID_VOTER_VALIDATION"
  | "DUPLICATE_VOTE_ATTEMPT"
  | "ADMIN_LOGIN_FAILURE"
  | "ADMIN_LOGIN_SUCCESS"
  | "RATE_LIMIT_TRIGGERED"
  | "INVALID_VOTE_PAYLOAD"
  | "UNAUTHORIZED_ROUTE_ACCESS";

export type SecurityEventSeverity = "info" | "warning" | "critical";

export async function logSecurityEvent(params: {
  type: SecurityEventType;
  severity?: SecurityEventSeverity;
  ipHash?: string;
  userAgentSummary?: string;
  route?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from("security_events").insert({
    type: params.type,
    severity: params.severity ?? "info",
    ip_hash: params.ipHash ?? null,
    user_agent_summary: params.userAgentSummary ?? null,
    route: params.route ?? null,
    metadata: params.metadata ?? {},
  });

  if (error) {
    console.error("failed to log security event", error);
  }
}
