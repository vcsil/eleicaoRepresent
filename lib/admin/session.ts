import "server-only";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import { generateSecureToken, sha256Hex } from "@/lib/security/hashing";

export const ADMIN_SESSION_COOKIE = "admin_session";
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 2; // 2 horas

export async function createAdminSession(ipHash: string | null): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = generateSecureToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000);

  const supabase = createServiceClient();
  const { error } = await supabase.from("admin_sessions").insert({
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
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
export async function getAdminSession(): Promise<{ id: string } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;

  const tokenHash = sha256Hex(token);
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("admin_sessions")
    .select("id, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at) < new Date()) return null;

  return { id: data.id };
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
