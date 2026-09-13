import { NextResponse, type NextRequest } from "next/server";

function getSupabaseHostname(): string {
  try {
    return new URL(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co",
    ).hostname;
  } catch {
    return "placeholder.supabase.co";
  }
}

const supabaseHostname = getSupabaseHostname();

/**
 * `'unsafe-eval'` APENAS em desenvolvimento, e por necessidade funcional
 * comprovada — não para calar o aviso do React.
 *
 * O runtime de dev do Turbopack aplica hot updates com
 * `_eval(code)` (passado como `evalModuleEntry` ao aplicador de update).
 * Com a CSP estrita, esse caminho é bloqueado e o Fast Refresh degrada
 * para recarga completa da página a cada salvamento — perdendo o estado
 * do componente, o que no meio da urna significa perder a distribuição
 * de votos em andamento. Verificado por A/B em Chromium: sem a diretiva,
 * "[Fast Refresh] performing full reload"; com ela, "done in 2ms" e o
 * estado preservado.
 *
 * O React também chama `(0, eval)("null")` como sonda de capacidade, em
 * try/catch, só para avisar que owner stacks ficarão degradadas.
 *
 * Em PRODUÇÃO a diretiva não entra, e não é dogma: o bundle de produção
 * foi varrido (30 chunks de cliente) e não contém `eval(` nem
 * `new Function(` — o bloco do React está atrás de um gate
 * `"development"` e o `_eval` do Turbopack é runtime de dev. Conceder
 * `'unsafe-eval'` em produção seria superfície de ataque sem nenhuma
 * contrapartida.
 */
const isDevelopment = process.env.NODE_ENV === "development";

export function buildCsp(nonce: string): string {
  const scriptSrc = [
    "script-src 'self'",
    isDevelopment ? "'unsafe-eval'" : null,
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: https://${supabaseHostname}`,
    "font-src 'self' data:",
    `connect-src 'self' https://${supabaseHostname} wss://${supabaseHostname}`,
    "frame-src https://www.youtube-nocookie.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload",
  );
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
