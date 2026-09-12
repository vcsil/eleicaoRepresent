import "server-only";

/** Extrai o IP do cliente a partir dos headers de proxy padrão. */
export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}

/** Resume o User-Agent sem guardar a string completa (minimização de dados). */
export function summarizeUserAgent(userAgent: string | null): string {
  if (!userAgent) return "unknown";
  return userAgent.slice(0, 160);
}
