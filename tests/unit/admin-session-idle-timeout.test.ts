import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ACTIVITY_HEARTBEAT_SECONDS,
  ADMIN_IDLE_TIMEOUT_SECONDS,
  ADMIN_SESSION_WARNING_SECONDS,
} from "@/lib/admin/session-config";

const read = (path: string) => readFileSync(path, "utf8");

describe("arquitetura do timeout administrativo", () => {
  it("centraliza a janela de cinco minutos, aviso e throttle", () => {
    expect(ADMIN_IDLE_TIMEOUT_SECONDS).toBe(300);
    expect(ADMIN_SESSION_WARNING_SECONDS).toBe(60);
    expect(ADMIN_ACTIVITY_HEARTBEAT_SECONDS).toBeGreaterThanOrEqual(30);
    expect(ADMIN_ACTIVITY_HEARTBEAT_SECONDS).toBeLessThanOrEqual(60);
  });

  it("preserva todas as propriedades seguras do cookie", () => {
    const source = read("lib/admin/session.ts");
    for (const property of ['httpOnly: true', 'secure: true', 'sameSite: "strict"', 'path: "/"']) {
      expect(source).toContain(property);
    }
    expect(source).toContain('ADMIN_SESSION_COOKIE = "admin_session"');
    expect(source).toContain("sha256Hex(token)");
  });

  it("não transforma polling ou eventos contínuos em atividade", () => {
    const source = read("components/admin/AdminIdleSessionProvider.tsx");
    expect(source).not.toContain('"mousemove"');
    expect(source).not.toContain('"scroll"');
    expect(source).toContain('"pointerdown", "keydown", "touchstart"');
    expect(source).toContain("ADMIN_ACTIVITY_HEARTBEAT_SECONDS");
  });

  it("instala o controle somente no layout admin protegido", () => {
    expect(read("app/admin/(protected)/layout.tsx")).toContain("AdminIdleSessionProvider");
    expect(read("app/(public)/layout.tsx")).not.toContain("AdminIdleSessionProvider");
  });

  it("protege cada ação administrativa antes de acessar entradas ou banco", () => {
    const files = [
      "candidatos/actions.ts",
      "cronograma/actions.ts",
      "dashboard/actions.ts",
      "desempates/actions.ts",
      "resultados/actions.ts",
      "votacao/actions.ts",
    ];
    for (const file of files) {
      const source = read(`app/admin/(protected)/${file}`);
      const bodies = source.split("export async function ").slice(1);
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body.indexOf("await requireAdminSession()"), file).toBeGreaterThan(-1);
        const guard = body.indexOf("await requireAdminSession()");
        const database = body.indexOf("createServiceClient()");
        if (database >= 0) expect(guard, file).toBeLessThan(database);
      }
    }
  });

  it("mantém logout manual com invalidação no servidor e exclusão do cookie", () => {
    expect(read("app/admin/actions.ts")).toContain("await destroyAdminSession()");
    expect(read("lib/admin/session.ts")).toContain("cookieStore.delete(ADMIN_SESSION_COOKIE)");
  });
});
