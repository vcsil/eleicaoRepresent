import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, resetDatabase, createTestElection, createVoter, validateVoter } from "./db";

describe("validate_voter (seção 92)", () => {
  let electionId: string;

  beforeAll(async () => {
    await resetDatabase();
    electionId = await createTestElection();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejeita matrícula inexistente com mensagem genérica", async () => {
    const result = await validateVoter(electionId, "não-existe", "Qualquer Nome");
    expect(result.status).toBe("invalid");
  });

  it("rejeita nome incorreto para uma matrícula existente", async () => {
    const voter = await createVoter("João da Silva");
    const result = await validateVoter(electionId, voter.registrationNumber, "Nome Errado");
    expect(result.status).toBe("invalid");
  });

  it("normaliza acentos, maiúsculas e espaços ao comparar o nome", async () => {
    const voter = await createVoter("  João   DA Silva ");
    const result = await validateVoter(electionId, voter.registrationNumber, "JOAO DA SILVA");
    expect(result.status).toBe("ok");
    expect(result.token).toBeTruthy();
  });

  it("aceita um eleitor ativo com dados corretos e emite uma sessão", async () => {
    const voter = await createVoter("Maria Souza");
    const result = await validateVoter(electionId, voter.registrationNumber, "Maria Souza");
    expect(result.status).toBe("ok");
    expect(result.expires_at).toBeTruthy();
  });

  it("rejeita um eleitor inativo mesmo com nome correto", async () => {
    const voter = await createVoter("Pedro Santos", false);
    const result = await validateVoter(electionId, voter.registrationNumber, "Pedro Santos");
    expect(result.status).toBe("invalid");
  });

  it("informa 'already_voted' apenas quando matrícula e nome já estão corretos", async () => {
    const voter = await createVoter("Ana Lima");
    await pool.query(
      `insert into ballots (id, election_id, submitted_at) values (gen_random_uuid(), $1, now())`,
      [electionId],
    );
    const { rows } = await pool.query(`select id from ballots where election_id = $1 limit 1`, [
      electionId,
    ]);
    await pool.query(
      `insert into audit_vote_links (election_id, voter_id, ballot_id) values ($1, $2, $3)`,
      [electionId, voter.id, rows[0].id],
    );

    const wrongName = await validateVoter(electionId, voter.registrationNumber, "Nome Errado");
    expect(wrongName.status).toBe("invalid");

    const correct = await validateVoter(electionId, voter.registrationNumber, "Ana Lima");
    expect(correct.status).toBe("already_voted");
  });
});
