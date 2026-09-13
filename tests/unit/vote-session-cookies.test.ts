import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O erro pós-voto ("Cookies can only be modified in a Server Action or
 * Route Handler") veio de a página /voto-confirmado — um Server Component
 * — deletar o cookie ao lê-lo. Pior: o delete só rodava quando o cookie
 * existia, ou seja, exatamente no caminho de sucesso do voto.
 *
 * Por isso o mock abaixo FALHA se set/delete forem chamados: o teste não
 * verifica só o retorno, verifica que a leitura não escreve.
 */

const store = new Map<string, string>();
const cookieSet = vi.fn(() => {
  throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
});
const cookieDelete = vi.fn(() => {
  throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (store.has(name) ? { name, value: store.get(name) } : undefined),
    set: cookieSet,
    delete: cookieDelete,
  }),
}));

// HMAC real (com chave fixa) em vez de um stub simplório: o helper trunca
// o digest em 16 caracteres, então um mock previsível poderia colidir no
// prefixo e mascarar justamente o que se quer provar.
vi.mock("@/lib/security/hashing", async () => {
  const { createHmac } = await import("node:crypto");
  return {
    hashKey: (value: string) =>
      createHmac("sha256", "chave-de-teste").update(value).digest("hex"),
  };
});

const { hasVoteConfirmedCookie, deriveDraftSessionKey, VOTE_CONFIRMED_COOKIE } = await import(
  "@/lib/election/vote-session"
);

beforeEach(() => {
  store.clear();
  cookieSet.mockClear();
  cookieDelete.mockClear();
});

describe("hasVoteConfirmedCookie", () => {
  it("devolve true sem escrever nada quando o cookie existe", async () => {
    store.set(VOTE_CONFIRMED_COOKIE, "1");

    await expect(hasVoteConfirmedCookie()).resolves.toBe(true);

    // A regressão real: qualquer escrita aqui derruba a página de sucesso.
    expect(cookieDelete).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("devolve false quando o cookie não existe", async () => {
    await expect(hasVoteConfirmedCookie()).resolves.toBe(false);
    expect(cookieDelete).not.toHaveBeenCalled();
  });

  it("devolve false para valor inesperado", async () => {
    store.set(VOTE_CONFIRMED_COOKIE, "sim");
    await expect(hasVoteConfirmedCookie()).resolves.toBe(false);
  });

  it("pode ser chamada repetidas vezes — recarregar a tela não a invalida", async () => {
    store.set(VOTE_CONFIRMED_COOKIE, "1");
    await expect(hasVoteConfirmedCookie()).resolves.toBe(true);
    await expect(hasVoteConfirmedCookie()).resolves.toBe(true);
    await expect(hasVoteConfirmedCookie()).resolves.toBe(true);
  });
});

describe("deriveDraftSessionKey", () => {
  it("é estável para a mesma sessão — recarregar preserva o rascunho", () => {
    const token = "token-de-sessao-com-mais-de-32-caracteres";
    expect(deriveDraftSessionKey(token)).toBe(deriveDraftSessionKey(token));
  });

  it("difere entre sessões — é o que impede o próximo eleitor de herdar", () => {
    expect(deriveDraftSessionKey("token-do-eleitor-A")).not.toBe(
      deriveDraftSessionKey("token-do-eleitor-B"),
    );
  });

  it("não contém o token", () => {
    const token = "token-secreto-do-eleitor";
    const key = deriveDraftSessionKey(token);
    expect(key).not.toContain(token);
    expect(key).toHaveLength(16);
  });
});
