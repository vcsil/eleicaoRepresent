import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/service";
import { generateSecureToken, sha256Hex } from "@/lib/security/hashing";
import { ADMIN_IDLE_TIMEOUT_SECONDS } from "@/lib/admin/session-config";
import { logAdminAction } from "@/lib/admin/audit-log";

export const ADMIN_SESSION_COOKIE = "admin_session";

export type AdminSession = { id: string; expiresAt: Date };

export async function createAdminSession(ipHash: string | null): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = generateSecureToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + ADMIN_IDLE_TIMEOUT_SECONDS * 1000);

  const supabase = createServiceClient();
  const { error } = await supabase.from("admin_sessions").insert({
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
    last_activity_at: new Date().toISOString(),
    ip_hash: ipHash,
  });
  if (error) throw error;

  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });

  return { token, expiresAt };
}

/** Verifica a sessão administrativa atual; não lança, apenas retorna o status. */
async function checkAdminSession(renew: boolean): Promise<AdminSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;

  const tokenHash = sha256Hex(token);
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("check_admin_session", {
    p_token_hash: tokenHash,
    p_renew: renew,
  });

  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) return null;

  return { id: row.session_id, expiresAt: new Date(row.expires_at) };
}

/** Verifica a sessão sem renovar atividade (seguro para render/polling/prefetch). */
export async function getAdminSession(): Promise<AdminSession | null> {
  return checkAdminSession(false);
}

/** Renova somente quando chamada explicitamente em resposta a atividade humana. */
export async function renewAdminSession(): Promise<AdminSession | null> {
  const session = await checkAdminSession(true);
  if (!session) return null;

  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  cookieStore.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    expires: session.expiresAt,
  });
  return session;
}

/** Guarda obrigatória no início de cada Server Action administrativa. */
export async function requireAdminSession(): Promise<AdminSession> {
  // Server Actions protegidas representam uma ação humana (salvar, publicar,
  // navegar por formulário), portanto também avançam a janela deslizante.
  const session = await renewAdminSession();
  if (!session) {
    await logAdminAction("ADMIN_SESSION_EXPIRED");
    return redirect("/admin?reason=expired");
  }
  return session;
}

export async function destroyAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (token) {
    const tokenHash = sha256Hex(token);
    const supabase = createServiceClient();
    await supabase.from("admin_sessions").delete().eq("token_hash", tokenHash);
  }
  cookieStore.delete(ADMIN_SESSION_COOKIE);
}
