"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { adminLoginSchema } from "@/lib/validation/schemas";
import { getServerEnv } from "@/lib/env";
import { createAdminSession, destroyAdminSession } from "@/lib/admin/session";
import { logAdminAction } from "@/lib/admin/audit-log";
import { getClientIp, summarizeUserAgent } from "@/lib/security/ip";
import { hashIp } from "@/lib/security/hashing";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { logSecurityEvent } from "@/lib/security/security-events";

const GENERIC_ERROR = "Credenciais inválidas.";

export type AdminLoginState = { error: string | null };

export async function adminLoginAction(
  _prevState: AdminLoginState,
  formData: FormData,
): Promise<AdminLoginState> {
  const parsed = adminLoginSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) {
    return { error: GENERIC_ERROR };
  }

  const headerList = await headers();
  const ipHash = hashIp(getClientIp(headerList));
  const userAgentSummary = summarizeUserAgent(headerList.get("user-agent"));

  const allowed = await checkRateLimit("admin_login", ipHash);
  if (!allowed) {
    await logSecurityEvent({
      type: "RATE_LIMIT_TRIGGERED",
      severity: "warning",
      ipHash,
      userAgentSummary,
      route: "/admin",
    });
    return { error: "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente." };
  }

  const { ADMIN_PASSWORD_HASH } = getServerEnv();
  const valid = await bcrypt.compare(parsed.data.password, ADMIN_PASSWORD_HASH);

  if (!valid) {
    await logSecurityEvent({
      type: "ADMIN_LOGIN_FAILURE",
      severity: "warning",
      ipHash,
      userAgentSummary,
      route: "/admin",
    });
    return { error: GENERIC_ERROR };
  }

  await createAdminSession(ipHash);
  await logAdminAction("ADMIN_LOGIN_SUCCESS", { ipHash });
  redirect("/admin/dashboard");
}

export async function adminLogoutAction(): Promise<void> {
  await logAdminAction("ADMIN_LOGOUT");
  await destroyAdminSession();
  redirect("/admin");
}
