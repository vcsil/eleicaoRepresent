import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type SecurityEventRow = {
  id: string;
  type: string;
  severity: string;
  route: string | null;
  created_at: string;
};

export async function getRecentSecurityEvents(limit = 50): Promise<SecurityEventRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("security_events")
    .select("id, type, severity, route, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export type AdminLogRow = {
  id: string;
  action: string;
  actor: string;
  created_at: string;
};

export async function getRecentAdminLogs(limit = 50): Promise<AdminLogRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("admin_logs")
    .select("id, action, actor, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}
