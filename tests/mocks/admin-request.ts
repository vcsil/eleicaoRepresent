import { vi } from "vitest";

/**
 * Escopo de requisição administrativa para testes de Server Action.
 *
 * Toda Server Action administrativa começa com `requireAdminSession()`, que
 * lê o cookie de sessão via `cookies()` — API que só existe dentro do
 * escopo de requisição do Next. Num teste unitário esse escopo não existe,
 * e o erro é `cookies was called outside a request scope`.
 *
 * Centralizado de propósito: quando a PR do logout por inatividade
 * acrescentou a guarda às actions, cada arquivo de teste teria que
 * descobrir isso sozinho — e o que aconteceu foi oito testes vermelhos até
 * alguém investigar. Com um ponto único, a próxima action protegida não
 * repete a história.
 *
 * Isto NÃO desliga a guarda: a action continua chamando
 * `requireAdminSession()` de verdade, e o que se simula é a sessão válida.
 * Para exercitar o caminho SEM sessão, use `{ authenticated: false }`.
 *
 * Uso (as fábricas ficam no arquivo de teste porque `vi.mock` é içado e só
 * funciona quando declarado no próprio módulo de teste):
 *
 *     const scope = createAdminRequestScope();
 *     vi.mock("next/headers", () => scope.nextHeaders());
 *     vi.mock("next/navigation", () => scope.nextNavigation());
 */

export const ADMIN_SESSION_COOKIE = "admin_session";

export type AdminRequestScope = {
  cookies: Map<string, string>;
  cookieSet: ReturnType<typeof vi.fn>;
  cookieDelete: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  /** Resposta de `check_admin_session`, para compor o mock do cliente de serviço. */
  checkAdminSessionResult(): { data: unknown; error: null };
  nextHeaders(): Record<string, unknown>;
  nextNavigation(): Record<string, unknown>;
  reset(): void;
};

export function createAdminRequestScope(
  options: { authenticated?: boolean } = {},
): AdminRequestScope {
  const authenticated = options.authenticated ?? true;

  const cookies = new Map<string, string>();
  if (authenticated) cookies.set(ADMIN_SESSION_COOKIE, "token-de-sessao-de-teste");

  const cookieSet = vi.fn((name: string, value: string) => void cookies.set(name, value));
  const cookieDelete = vi.fn((name: string) => void cookies.delete(name));

  const redirect = vi.fn((url: string) => {
    // O `redirect()` do Next lança para interromper a execução; reproduzir
    // isso é o que faz a action realmente parar quando não há sessão.
    const error = new Error("NEXT_REDIRECT");
    (error as Error & { url?: string }).url = url;
    throw error;
  });

  return {
    cookies,
    cookieSet,
    cookieDelete,
    redirect,

    checkAdminSessionResult: () =>
      authenticated
        ? {
            data: [
              {
                session_id: "11111111-1111-4111-8111-111111111111",
                expires_at: new Date(Date.now() + 600_000).toISOString(),
              },
            ],
            error: null,
          }
        : { data: [], error: null },

    nextHeaders: () => ({
      cookies: async () => ({
        get: (name: string) => (cookies.has(name) ? { name, value: cookies.get(name) } : undefined),
        set: cookieSet,
        delete: cookieDelete,
      }),
      headers: async () => new Headers({ "user-agent": "vitest" }),
    }),

    nextNavigation: () => ({ redirect }),

    reset() {
      cookieSet.mockClear();
      cookieDelete.mockClear();
      redirect.mockClear();
    },
  };
}
