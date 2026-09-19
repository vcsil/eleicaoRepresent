import { randomUUID } from "node:crypto";
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
  type TestPosition,
} from "./db";

describe("cast_ballot (seções 26-40, 86, 93-94)", () => {
  let posA: TestPosition; // votes_per_voter = 1
  let posB: TestPosition; // votes_per_voter = 3
  let candA1: string;
  let candB1: string;
  let candB2: string;
  let candB3: string;

  beforeAll(async () => {
    await resetDatabase();
    await createTestElection();

    posA = await createPosition({ slug: "posicao-a", votesPerVoter: 1, vacancies: 1 });
    posB = await createPosition({ slug: "posicao-b", votesPerVoter: 3, vacancies: 3 });

    candA1 = await createCandidate("Candidato A1", [posA.id]);
    candB1 = await createCandidate("Candidato B1", [posB.id]);
    candB2 = await createCandidate("Candidato B2", [posB.id]);
    candB3 = await createCandidate("Candidato B3", [posB.id]);

    // Um candidato a mais por cargo, para que ambos tenham DISPUTA: desde a
    // migration 0020, cargo cujos candidatos não superam as vagas sai da
    // urna. Estes dois não recebem voto em teste nenhum — existem só para
    // que os cargos continuem votáveis e cada teste siga verificando o que
    // sempre verificou (soma exata, nulo, repetição).
    await createCandidate("Candidato A2", [posA.id]);
    await createCandidate("Candidato B4", [posB.id]);
  });

  afterAll(async () => {
    await pool.end();
  });

  let voterCounter = 0;
  async function getToken(): Promise<string> {
    voterCounter += 1;
    const fullName = `Eleitor Teste ${voterCounter} ${randomUUID()}`;
    const voter = await createVoter(fullName);
    const { rows } = await pool.query<{ id: string }>(`select id from elections limit 1`);
    const electionId = rows[0].id;
    const result = await validateVoter(electionId, voter.registrationNumber, fullName);
    if (result.status !== "ok") {
      throw new Error(`expected ok, got ${result.status}`);
    }
    return result.token!;
  }

  function payload(posBAllocations: { candidate_id: string | null; is_null_vote: boolean; quantity: number }[], extra?: Record<string, unknown>) {
    return {
      positions: [
        {
          position_id: posA.id,
          allocations: [{ candidate_id: candA1, is_null_vote: false, quantity: 1 }],
        },
        {
          position_id: posB.id,
          allocations: posBAllocations,
          ...extra,
        },
      ],
    };
  }

  it("aceita soma correta distribuída entre candidatos diferentes", async () => {
    const token = await getToken();
    const ballotId = await castBallot(
      token,
      payload([
        { candidate_id: candB1, is_null_vote: false, quantity: 1 },
        { candidate_id: candB2, is_null_vote: false, quantity: 1 },
        { candidate_id: candB3, is_null_vote: false, quantity: 1 },
      ]),
    );
    expect(ballotId).toBeTruthy();
  });

  it("aceita todos os votos concentrados no mesmo candidato", async () => {
    const token = await getToken();
    const ballotId = await castBallot(
      token,
      payload([{ candidate_id: candB1, is_null_vote: false, quantity: 3 }]),
    );
    expect(ballotId).toBeTruthy();
  });

  it("aceita candidato + Nulo misturados", async () => {
    const token = await getToken();
    const ballotId = await castBallot(
      token,
      payload([
        { candidate_id: candB1, is_null_vote: false, quantity: 2 },
        { candidate_id: null, is_null_vote: true, quantity: 1 },
      ]),
    );
    expect(ballotId).toBeTruthy();
  });

  it("aceita todos os votos como Nulo", async () => {
    const token = await getToken();
    const ballotId = await castBallot(token, payload([{ candidate_id: null, is_null_vote: true, quantity: 3 }]));
    expect(ballotId).toBeTruthy();
  });

  it("rejeita soma inferior ao obrigatório", async () => {
    const token = await getToken();
    await expect(
      castBallot(token, payload([{ candidate_id: candB1, is_null_vote: false, quantity: 2 }])),
    ).rejects.toThrow(/INVALID_VOTE_SUM/);
  });

  it("rejeita soma superior ao permitido", async () => {
    const token = await getToken();
    await expect(
      castBallot(token, payload([{ candidate_id: candB1, is_null_vote: false, quantity: 4 }])),
    ).rejects.toThrow(/INVALID_VOTE_SUM/);
  });

  it("rejeita quantidade negativa", async () => {
    const token = await getToken();
    await expect(
      castBallot(
        token,
        payload([
          { candidate_id: candB1, is_null_vote: false, quantity: -1 },
          { candidate_id: candB2, is_null_vote: false, quantity: 4 },
        ]),
      ),
    ).rejects.toThrow(/INVALID_PAYLOAD/);
  });

  it("rejeita quantidade decimal", async () => {
    const token = await getToken();
    await expect(
      castBallot(
        token,
        payload([{ candidate_id: candB1, is_null_vote: false, quantity: 1.5 as unknown as number }]),
      ),
    ).rejects.toThrow(/INVALID_PAYLOAD/);
  });

  it("rejeita candidato inexistente", async () => {
    const token = await getToken();
    await expect(
      castBallot(token, payload([{ candidate_id: randomUUID(), is_null_vote: false, quantity: 3 }])),
    ).rejects.toThrow(/INVALID_CANDIDATE/);
  });

  it("rejeita candidato registrado em outro cargo", async () => {
    const token = await getToken();
    await expect(
      castBallot(token, payload([{ candidate_id: candA1, is_null_vote: false, quantity: 3 }])),
    ).rejects.toThrow(/INVALID_CANDIDATE/);
  });

  it("rejeita payload com campo inesperado (adulterado)", async () => {
    const token = await getToken();
    const tampered = payload([{ candidate_id: candB1, is_null_vote: false, quantity: 3 }]);
    (tampered.positions[1].allocations[0] as unknown as Record<string, unknown>).totalVotes = 3;
    await expect(castBallot(token, tampered)).rejects.toThrow(/INVALID_PAYLOAD/);
  });

  it("rejeita reenvio com uma sessão já consumida", async () => {
    const token = await getToken();
    await castBallot(token, payload([{ candidate_id: candB1, is_null_vote: false, quantity: 3 }]));
    await expect(
      castBallot(token, payload([{ candidate_id: candB2, is_null_vote: false, quantity: 3 }])),
    ).rejects.toThrow(/SESSION_INVALID/);
  });

  it("não registra nada quando a submissão é rejeitada (atomicidade)", async () => {
    const token = await getToken();
    const before = await pool.query(`select count(*) from ballots`);
    await expect(
      castBallot(token, payload([{ candidate_id: candB1, is_null_vote: false, quantity: 4 }])),
    ).rejects.toThrow();
    const after = await pool.query(`select count(*) from ballots`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("sob concorrência, duas submissões simultâneas da mesma sessão — só uma vence (seção 94)", async () => {
    const token = await getToken();
    const attempt = () =>
      castBallot(token, payload([{ candidate_id: candB1, is_null_vote: false, quantity: 3 }]));

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
