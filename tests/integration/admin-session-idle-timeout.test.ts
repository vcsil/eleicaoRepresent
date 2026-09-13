import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "./db";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

async function createSession(activityAge = "0 seconds") {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hash(token);
  await pool.query(
    `insert into admin_sessions (token_hash, last_activity_at, expires_at)
     values ($1, now() - $2::interval, now() - $2::interval + interval '5 minutes')`,
    [tokenHash, activityAge],
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

  it("aceita atividade dentro dos últimos cinco minutos", async () => {
    const session = await createSession("4 minutes 50 seconds");
    expect(await check(session.tokenHash)).toBeDefined();
  });

  it("rejeita e remove sessão inativa há mais de cinco minutos", async () => {
    const session = await createSession("5 minutes 1 second");
    expect(await check(session.tokenHash)).toBeUndefined();
    const { rowCount } = await pool.query("select 1 from admin_sessions where token_hash = $1", [
      session.tokenHash,
    ]);
    expect(rowCount).toBe(0);
  });

  it("atividade explícita renova last_activity_at e o prazo", async () => {
    const session = await createSession("4 minutes");
    const renewed = await check(session.tokenHash, true);
    expect(renewed).toBeDefined();
    expect(new Date(renewed!.expires_at).getTime()).toBeGreaterThan(Date.now() + 290_000);
    const { rows } = await pool.query(
      "select extract(epoch from (expires_at - last_activity_at)) as window from admin_sessions where token_hash = $1",
      [session.tokenHash],
    );
    expect(Number(rows[0].window)).toBeCloseTo(300, 0);
  });

  it("uma sessão removida pelo logout não pode ser renovada", async () => {
    const session = await createSession();
    await pool.query("delete from admin_sessions where token_hash = $1", [session.tokenHash]);
    expect(await check(session.tokenHash, true)).toBeUndefined();
  });

  it("renovações simultâneas preservam uma única sessão válida", async () => {
    const session = await createSession("4 minutes");
    const results = await Promise.all(Array.from({ length: 6 }, () => check(session.tokenHash, true)));
    expect(results.every(Boolean)).toBe(true);
    const { rows } = await pool.query(
      "select count(*)::int as count from admin_sessions where token_hash = $1 and expires_at > now()",
      [session.tokenHash],
    );
    expect(rows[0].count).toBe(1);
  });

  it("permite criar e validar nova sessão após a anterior expirar", async () => {
    const expired = await createSession("6 minutes");
    expect(await check(expired.tokenHash)).toBeUndefined();
    const replacement = await createSession();
    expect(await check(replacement.tokenHash)).toBeDefined();
  });
});

