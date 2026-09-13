import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `'unsafe-eval'` existe SÓ em desenvolvimento, por necessidade funcional
 * do Fast Refresh do Turbopack (que aplica hot updates via eval). Em
 * produção o bundle não contém eval algum, então a diretiva seria
 * superfície de ataque sem contrapartida.
 *
 * Este teste trava as duas metades: que a diretiva aparece em dev e que
 * NUNCA vaza para produção.
 */

async function loadCsp(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  const { buildCsp } = await import("@/proxy");
  return buildCsp("nonce-de-teste");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CSP por ambiente", () => {
  it("development permite unsafe-eval", async () => {
    expect(await loadCsp("development")).toContain("'unsafe-eval'");
  });

  it("production NÃO permite unsafe-eval", async () => {
    expect(await loadCsp("production")).not.toContain("'unsafe-eval'");
  });

  it("test também não permite — só dev é exceção", async () => {
    expect(await loadCsp("test")).not.toContain("'unsafe-eval'");
  });
});

describe("diretivas que não podem ser enfraquecidas", () => {
  for (const env of ["development", "production"]) {
    it(`${env} mantém nonce, strict-dynamic e as travas de embedding`, async () => {
      const csp = await loadCsp(env);
      expect(csp).toContain("'nonce-nonce-de-teste'");
      expect(csp).toContain("'strict-dynamic'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("default-src 'self'");
    });

    it(`${env} nunca libera unsafe-inline em script-src`, async () => {
      const csp = await loadCsp(env);
      const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
      expect(scriptSrc).toBeDefined();
      expect(scriptSrc).not.toContain("'unsafe-inline'");
    });
  }
});
