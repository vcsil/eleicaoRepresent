import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_IDLE_TIMEOUT_SECONDS } from "@/lib/admin/session-config";
import { pool } from "./db";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// Todo o arquivo é parametrizado por ADMIN_IDLE_TIMEOUT_SECONDS de propósito:
// nenhum número de janela é escrito à mão aqui. Se alguém mudar a constante do
// TypeScript sem escrever a migration correspondente (ou vice-versa), o teste
// "a janela do banco coincide com ADMIN_IDLE_TIMEOUT_SECONDS" quebra.
const IDLE = ADMIN_IDLE_TIMEOUT_SECONDS;

async function createSession(activityAgeSeconds = 0) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hash(token);
  await pool.query(
    `insert into admin_sessions (token_hash, last_activity_at, expires_at)
     values (
       $1,
       now() - make_interval(secs => $2),
       now() - make_interval(secs => $2) + make_interval(secs => $3)
     )`,
    [tokenHash, activityAgeSeconds, IDLE],
  );
  return { token, tokenHash };
}

async function check(tokenHash: string, renew = false) {
  const { rows } = await pool.query(
    `select * from check_admin_session($1, $2)`,
    [tokenHash, renew],
  );
  return rows[0] as { session_id: string; expires_at: Date } | undefined;
}

describe("timeout por inatividade da sessão administrativa", () => {
  beforeEach(async () => {
    await pool.query("truncate table admin_sessions, admin_logs cascade");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("aceita sessão recém-criada", async () => {
    const session = await createSession();
    expect(await check(session.tokenHash)).toBeDefined();
  });

  it("aceita atividade dentro da janela de inatividade", async () => {
    const session = await createSession(IDLE - 10);
    expect(await check(session.tokenHash)).toBeDefined();
  });

  it("rejeita e remove sessão inativa além da janela", async () => {
    const session = await createSession(IDLE + 1);
    expect(await check(session.tokenHash)).toBeUndefined();
    const { rowCount } = await pool.query("select 1 from admin_sessions where token_hash = $1", [
      session.tokenHash,
    ]);
    expect(rowCount).toBe(0);
  });

  it("atividade explícita renova last_activity_at e o prazo", async () => {
    const session = await createSession(60);
    const renewed = await check(session.tokenHash, true);
    expect(renewed).toBeDefined();
    // Renovar joga o vencimento para ~IDLE segundos à frente de agora; a folga
    // de 10s absorve a latência da própria consulta.
    expect(new Date(renewed!.expires_at).getTime()).toBeGreaterThan(
      Date.now() + (IDLE - 10) * 1000,
    );
  });

  it("a janela concedida pelo banco coincide com ADMIN_IDLE_TIMEOUT_SECONDS", async () => {
    // Guarda de divergência: o intervalo real está hardcoded dentro de
    // check_admin_session (migration 0018) e a interface usa a constante do
    // TypeScript para decidir quando avisar/deslogar. Se o servidor conceder
    // menos tempo do que o cliente acredita ter, o administrador é deslogado no
    // meio de uma operação sem aviso; se conceder mais, o aviso aparece cedo
    // demais. Este teste lê a janela que o banco de fato aplica.
    const session = await createSession(60);
    await check(session.tokenHash, true);
    const { rows } = await pool.query(
      `select extract(epoch from (expires_at - last_activity_at)) as window
         from admin_sessions where token_hash = $1`,
      [session.tokenHash],
    );
    expect(Number(rows[0].window)).toBeCloseTo(IDLE, 0);
  });

  it("uma sessão removida pelo logout não pode ser renovada", async () => {
    const session = await createSession();
    await pool.query("delete from admin_sessions where token_hash = $1", [session.tokenHash]);
    expect(await check(session.tokenHash, true)).toBeUndefined();
  });

  it("renovações simultâneas preservam uma única sessão válida", async () => {
    const session = await createSession(60);
    const results = await Promise.all(Array.from({ length: 6 }, () => check(session.tokenHash, true)));
    expect(results.every(Boolean)).toBe(true);
    const { rows } = await pool.query(
      "select count(*)::int as count from admin_sessions where token_hash = $1 and expires_at > now()",
      [session.tokenHash],
    );
    expect(rows[0].count).toBe(1);
  });

  it("permite criar e validar nova sessão após a anterior expirar", async () => {
    const expired = await createSession(IDLE + 60);
    expect(await check(expired.tokenHash)).toBeUndefined();
    const replacement = await createSession();
    expect(await check(replacement.tokenHash)).toBeDefined();
  });
});
