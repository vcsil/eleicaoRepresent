import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Duas regressões do fluxo de validação, ambas ligadas ao uso do mesmo
 * dispositivo/rede por vários eleitores:
 *
 * 1. Os limites por IP e por matrícula usavam o mesmo teto (8/5min). No
 *    wi-fi da faculdade a turma inteira sai pelo mesmo IP público, então o
 *    9º eleitor em 5 minutos era barrado — e o bloqueio ainda escalava.
 * 2. O cookie de confirmação do eleitor anterior sobrevivia, e quem
 *    assumisse o dispositivo podia topar com "seu voto foi registrado"
 *    antes de ter votado.
 */

type RpcResult = { data: unknown; error: unknown };
const rpc = vi.fn<(fn: string, params?: Record<string, unknown>) => Promise<RpcResult>>(
  async () => ({ data: true, error: null }),
);
const cookieSet = vi.fn();
const cookieDelete = vi.fn();

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ rpc }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: cookieSet, delete: cookieDelete }),
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.5" }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as Error & { url?: string }).url = url;
    throw error;
  },
}));

vi.mock("@/lib/security/security-events", () => ({ logSecurityEvent: async () => {} }));

// getMainElection é envolvida por unstable_cache, que exige o contexto de
// cache do Next — indisponível num teste unitário. O que importa aqui é o
// comportamento da action, não a leitura da eleição.
vi.mock("@/lib/election/status", () => ({
  getMainElection: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
}));
vi.mock("@/lib/security/hashing", async () => {
  const { createHmac } = await import("node:crypto");
  const h = (v: string) => createHmac("sha256", "chave-de-teste").update(v).digest("hex");
  return { hashIp: h, hashKey: h };
});

const { checkRateLimit } = await import("@/lib/security/rate-limit");

beforeEach(() => {
  rpc.mockClear();
  cookieSet.mockClear();
  cookieDelete.mockClear();
});

function lastRpcArgs(): Record<string, unknown> {
  return rpc.mock.calls.at(-1)?.[1] ?? {};
}

describe("tetos de rate limit por dimensão", () => {
  it("o limite por IP tolera a turma inteira na mesma rede", async () => {
    await checkRateLimit("voter_validate_ip", "hash-de-ip");
    expect(lastRpcArgs()).toMatchObject({
      p_scope: "voter_validate_ip",
      p_max_attempts: 100,
      p_window_seconds: 300,
    });
  });

  it("o limite por matrícula continua estrito — é o anti-força-bruta real", async () => {
    await checkRateLimit("voter_validate_registration", "hash-de-matricula");
    expect(lastRpcArgs()).toMatchObject({
      p_scope: "voter_validate_registration",
      p_max_attempts: 10,
      p_window_seconds: 300,
    });
  });

  it("as duas dimensões usam contadores separados no banco", async () => {
    await checkRateLimit("voter_validate_ip", "mesma-chave");
    const porIp = lastRpcArgs().p_scope;
    await checkRateLimit("voter_validate_registration", "mesma-chave");
    expect(lastRpcArgs().p_scope).not.toBe(porIp);
  });

  it("o login administrativo permanece o mais restrito de todos", async () => {
    await checkRateLimit("admin_login", "hash-de-ip");
    expect(lastRpcArgs()).toMatchObject({ p_max_attempts: 5, p_block_seconds: 120 });
  });
});

describe("validateVoterAction em dispositivo compartilhado", () => {
  it("apaga a confirmação do eleitor anterior ao validar um novo", async () => {
    const { validateVoterAction } = await import("@/app/(public)/votar/actions");
    const { VOTE_CONFIRMED_COOKIE } = await import("@/lib/election/vote-session");

    rpc.mockImplementation(async (fn) => {
      if (fn === "check_and_increment_rate_limit") return { data: true, error: null };
      if (fn === "validate_voter") {
        return {
          data: {
            status: "ok",
            token: "t".repeat(64),
            expires_at: new Date(Date.now() + 1200_000).toISOString(),
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    const formData = new FormData();
    formData.set("registration_number", "2020123456");
    formData.set("full_name", "Maria Souza");

    // O sucesso termina em redirect, que o mock transforma em throw.
    await expect(validateVoterAction({ error: null }, formData)).rejects.toThrow("NEXT_REDIRECT");

    expect(cookieDelete).toHaveBeenCalledWith(VOTE_CONFIRMED_COOKIE);
  });
});
