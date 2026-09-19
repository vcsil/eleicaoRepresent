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

/**
 * Regressão para dois bugs encontrados manualmente durante o
 * desenvolvimento: (1) MIN/MAX não existem para uuid no Postgres — a
 * detecção de cargo duplo usava min(position_id)/max(position_id) e
 * falhava; (2) resolve_dual_winner_decision podia "promover de volta" o
 * próprio candidato que acabou de abrir mão da vaga.
 */
describe("resolve_dual_winner_decision (seções 53-54)", () => {
  let electionId: string;
  let posP: TestPosition;
  let posM: TestPosition;
  let candidateX: string; // eleito nas duas posições
  let candidateY: string; // segundo colocado em posM, deve ser promovido

  beforeAll(async () => {
    await resetDatabase();
    electionId = await createTestElection();

    posP = await createPosition({ slug: "presidente-like", votesPerVoter: 1, vacancies: 1 });
    posM = await createPosition({ slug: "marketing-like", votesPerVoter: 1, vacancies: 1 });

    candidateX = await createCandidate("Candidato X", [posP.id, posM.id]);
    candidateY = await createCandidate("Candidato Y", [posM.id]);

    // posP precisa de DISPUTA para entrar na urna (migration 0020): sem um
    // segundo nome, 1 candidato para 1 vaga sairia da cédula. Este não
    // recebe voto nenhum — X vence posP por 3 a 0, sem empate.
    await createCandidate("Candidato Z", [posP.id]);

    async function vote(fullName: string, pAlloc: string, mAlloc: string) {
      const voter = await createVoter(fullName);
      const session = await validateVoter(electionId, voter.registrationNumber, fullName);
      if (session.status !== "ok") throw new Error(`unexpected ${session.status}`);
      await castBallot(session.token!, {
        positions: [
          { position_id: posP.id, allocations: [{ candidate_id: pAlloc, is_null_vote: false, quantity: 1 }] },
          { position_id: posM.id, allocations: [{ candidate_id: mAlloc, is_null_vote: false, quantity: 1 }] },
        ],
      });
    }

    // candidateX vence posP (único votante) e posM (2 votos contra 1 de Y).
    await vote("Eleitor 1", candidateX, candidateX);
    await vote("Eleitor 2", candidateX, candidateX);
    await vote("Eleitor 3", candidateX, candidateY);

    await closeVoting(electionId);
    await pool.query(`select compute_results($1)`, [electionId]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("detecta o candidato eleito em duas posições e cria uma decisão pendente", async () => {
    const { rows } = await pool.query(
      `select id, position_id_a, position_id_b, status from position_dual_winner_decisions
       where election_id = $1 and candidate_id = $2`,
      [electionId, candidateX],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("ao escolher posP, libera posM e promove o segundo colocado (não o próprio candidato)", async () => {
    const decision = await pool.query(
      `select id from position_dual_winner_decisions where election_id = $1 and candidate_id = $2`,
      [electionId, candidateX],
    );
    await pool.query(`select resolve_dual_winner_decision($1, $2)`, [decision.rows[0].id, posP.id]);

    const marketingResults = await pool.query(
      `select candidate_id, elected from result_snapshots
       where election_id = $1 and position_id = $2 and candidate_id is not null
       order by rank`,
      [electionId, posM.id],
    );

    const byCandidate = Object.fromEntries(marketingResults.rows.map((r) => [r.candidate_id, r.elected]));
    expect(byCandidate[candidateX]).toBe(false);
    expect(byCandidate[candidateY]).toBe(true);

    const reassignment = await pool.query(
      `select vacated_by_candidate_id, promoted_candidate_id from seat_reassignments where election_id = $1`,
      [electionId],
    );
    expect(reassignment.rows[0].vacated_by_candidate_id).toBe(candidateX);
    expect(reassignment.rows[0].promoted_candidate_id).toBe(candidateY);
  });

  it("publish_results funciona após a decisão de cargo duplo ser resolvida", async () => {
    await expect(pool.query(`select publish_results($1)`, [electionId])).resolves.toBeDefined();
  });
});
