import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  pool,
  resetDatabase,
  createTestElection,
  createPosition,
  createCandidate,
  createVoter,
  validateVoter,
  castBallot,
  closeVoting,
  type TestPosition,
} from "./db";

describe("compute_results / publish_results (seções 49, 52, 84-86, 97)", () => {
  let electionId: string;
  let posTie: TestPosition; // 1 vaga, vai empatar
  let posMulti: TestPosition; // 2 vagas, votos repetidos + nulos
  let candTieA: string;
  let candTieB: string;
  let candMultiA: string;
  let candMultiB: string;

  async function vote(
    fullName: string,
    tieAllocation: { candidate_id: string | null; is_null_vote: boolean; quantity: number }[],
    multiAllocations: { candidate_id: string | null; is_null_vote: boolean; quantity: number }[],
  ) {
    const voter = await createVoter(fullName);
    const session = await validateVoter(electionId, voter.registrationNumber, fullName);
    if (session.status !== "ok") throw new Error(`unexpected status ${session.status}`);
    await castBallot(session.token!, {
      positions: [
        { position_id: posTie.id, allocations: tieAllocation },
        { position_id: posMulti.id, allocations: multiAllocations },
      ],
    });
  }

  beforeAll(async () => {
    await resetDatabase();
    electionId = await createTestElection();

    posTie = await createPosition({ slug: "tie", votesPerVoter: 1, vacancies: 1 });
    posMulti = await createPosition({ slug: "multi", votesPerVoter: 2, vacancies: 2 });

    candTieA = await createCandidate("Empate A", [posTie.id]);
    candTieB = await createCandidate("Empate B", [posTie.id]);
    candMultiA = await createCandidate("Multi A", [posMulti.id]);
    candMultiB = await createCandidate("Multi B", [posMulti.id]);

    // Empate 1x1 entre candTieA e candTieB.
    await vote("Eleitor 1", [{ candidate_id: candTieA, is_null_vote: false, quantity: 1 }], [
      { candidate_id: candMultiA, is_null_vote: false, quantity: 2 },
    ]);
    await vote("Eleitor 2", [{ candidate_id: candTieB, is_null_vote: false, quantity: 1 }], [
      { candidate_id: null, is_null_vote: true, quantity: 2 },
    ]);

    await closeVoting(electionId);
    await pool.query(`select compute_results($1)`, [electionId]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("marca tie_break_needed para os candidatos empatados na fronteira das vagas", async () => {
    const { rows } = await pool.query(
      `select candidate_id, votes_count, tie_break_needed, elected
       from result_snapshots where election_id = $1 and position_id = $2 and candidate_id is not null`,
      [electionId, posTie.id],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.votes_count).toBe(1);
      expect(row.tie_break_needed).toBe(true);
      expect(row.elected).toBe(false);
    }
  });

  it("soma corretamente votos repetidos no mesmo candidato", async () => {
    const { rows } = await pool.query(
      `select votes_count, elected from result_snapshots
       where election_id = $1 and position_id = $2 and candidate_id = $3`,
      [electionId, posMulti.id, candMultiA],
    );
    expect(rows[0].votes_count).toBe(2);
    expect(rows[0].elected).toBe(true);
  });

  it("contabiliza nulos separadamente do candidato (não entram na classificação)", async () => {
    const { rows } = await pool.query(
      `select votes_count from result_snapshots
       where election_id = $1 and position_id = $2 and candidate_id is null`,
      [electionId, posMulti.id],
    );
    expect(rows[0].votes_count).toBe(2);

    const candB = await pool.query(
      `select votes_count from result_snapshots
       where election_id = $1 and position_id = $2 and candidate_id = $3`,
      [electionId, posMulti.id, candMultiB],
    );
    expect(candB.rows[0].votes_count).toBe(0);
  });

  it("publish_results é bloqueado enquanto houver empate pendente", async () => {
    await expect(pool.query(`select publish_results($1)`, [electionId])).rejects.toThrow(/TIE_PENDING/);
  });

  it("RLS: anon não vê resultados antes da publicação, mas vê depois", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role anon");
      const before = await client.query(
        `select count(*) from result_snapshots where election_id = $1`,
        [electionId],
      );
      expect(Number(before.rows[0].count)).toBe(0);
      await client.query("rollback");
    } finally {
      client.release();
    }

    // Resolve o empate para permitir a publicação e confirmar a liberação.
    await pool.query(
      `delete from result_snapshots where election_id = $1 and position_id = $2 and candidate_id = $3`,
      [electionId, posTie.id, candTieB],
    );
    await pool.query(
      `update result_snapshots set elected = true, tie_break_needed = false
       where election_id = $1 and position_id = $2 and candidate_id = $3`,
      [electionId, posTie.id, candTieA],
    );
    await pool.query(`select publish_results($1)`, [electionId]);

    const client2 = await pool.connect();
    try {
      await client2.query("begin");
      await client2.query("set local role anon");
      const after = await client2.query(
        `select count(*) from result_snapshots where election_id = $1`,
        [electionId],
      );
      expect(Number(after.rows[0].count)).toBeGreaterThan(0);
      const voters = await client2.query(`select count(*) from voters`).catch((e) => e);
      expect(voters).toBeInstanceOf(Error);
      await client2.query("rollback");
    } finally {
      client2.release();
    }
  });
});
