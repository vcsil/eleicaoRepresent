import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, resetDatabase, createTestElection } from "./db";

/**
 * Garantias de exclusão de eleitor, contra o Postgres real.
 *
 * A proteção do histórico NÃO é código de aplicação: `audit_vote_links.voter_id`
 * referencia `voters(id)` sem ON DELETE CASCADE, então o banco recusa o
 * DELETE. Estes testes fixam isso — se alguém acrescentar um CASCADE numa
 * migration futura, quebram aqui antes de virar perda de histórico.
 */
async function q(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(sql, params);
  return rows as Record<string, unknown>[];
}

async function criarEleitor(matricula: string, nome: string) {
  const rows = await q(
    `insert into voters (registration_number, full_name, normalized_name)
     values ($1, $2, normalize_name($2)) returning id`,
    [matricula, nome],
  );
  return rows[0].id as string;
}

async function registrarVoto(electionId: string, voterId: string) {
  const [ballot] = await q("insert into ballots (election_id) values ($1) returning id", [electionId]);
  await q(
    "insert into ballot_choices (ballot_id, position_id, is_null_vote, vote_slot) values ($1, null, true, 1)",
    [ballot.id],
  ).catch(async () => {
    // ballot_choices exige position_id; se o schema pedir, cria um cargo.
    const [p] = await q(
      `insert into positions (slug, name, vacancies, votes_per_voter, display_order)
       values ('p-teste', 'Cargo Teste', 1, 1, 1) returning id`,
    );
    await q(
      "insert into ballot_choices (ballot_id, position_id, is_null_vote, vote_slot) values ($1, $2, true, 1)",
      [ballot.id, p.id],
    );
  });
  await q("insert into audit_vote_links (election_id, voter_id, ballot_id) values ($1, $2, $3)", [
    electionId,
    voterId,
    ballot.id,
  ]);
  return ballot.id as string;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("exclusão de eleitor no banco", () => {
  it("eleitor A, que nunca votou, pode ser excluído", async () => {
    const id = await criarEleitor("A0001", "Ana Sem Voto");
    await q("delete from voters where id = $1", [id]);
    expect(await q("select 1 from voters where id = $1", [id])).toHaveLength(0);
  });

  it("sessão de votação pendente sai junto, em cascata", async () => {
    const electionId = await createTestElection();
    const id = await criarEleitor("A0002", "Ana Com Sessao");
    await q(
      `insert into vote_sessions (election_id, voter_id, token_hash, expires_at)
       values ($1, $2, 'token-pendente', now() + interval '1 hour')`,
      [electionId, id],
    );

    await q("delete from voters where id = $1", [id]);

    // Um token de urna sem eleitor não pode continuar válido.
    expect(await q("select 1 from vote_sessions where token_hash = 'token-pendente'")).toHaveLength(0);
  });

  it("eleitor B, que já votou, NÃO pode ser excluído", async () => {
    const electionId = await createTestElection();
    const id = await criarEleitor("B0001", "Bruno Votou");
    await registrarVoto(electionId, id);

    await expect(q("delete from voters where id = $1", [id])).rejects.toThrow(
      /violates foreign key constraint "audit_vote_links_voter_id_fkey"/,
    );
  });

  it("depois da recusa, eleitor, voto e vínculo de auditoria seguem intactos", async () => {
    const electionId = await createTestElection();
    const id = await criarEleitor("B0002", "Bruno Intacto");
    const ballotId = await registrarVoto(electionId, id);

    await expect(q("delete from voters where id = $1", [id])).rejects.toThrow();

    expect(await q("select 1 from voters where id = $1", [id])).toHaveLength(1);
    expect(await q("select 1 from audit_vote_links where voter_id = $1", [id])).toHaveLength(1);
    expect(await q("select 1 from ballots where id = $1", [ballotId])).toHaveLength(1);
    expect(await q("select 1 from ballot_choices where ballot_id = $1", [ballotId])).toHaveLength(1);
  });

  it("inativar é a saída para quem já votou: preserva todo o histórico", async () => {
    const electionId = await createTestElection();
    const id = await criarEleitor("B0003", "Bruno Inativado");
    const ballotId = await registrarVoto(electionId, id);

    await q("update voters set active = false where id = $1", [id]);

    const [voter] = await q("select active from voters where id = $1", [id]);
    expect(voter.active).toBe(false);
    expect(await q("select 1 from audit_vote_links where voter_id = $1", [id])).toHaveLength(1);
    expect(await q("select 1 from ballots where id = $1", [ballotId])).toHaveLength(1);
  });

  it("a FK que protege o histórico NÃO é cascade", async () => {
    // Fixa a regra: se alguém trocar para CASCADE numa migration futura,
    // excluir um eleitor apagaria silenciosamente o vínculo de auditoria.
    const [regra] = await q(
      `select rc.delete_rule
         from information_schema.table_constraints tc
         join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
        where tc.constraint_name = 'audit_vote_links_voter_id_fkey'`,
    );
    expect(regra.delete_rule).toBe("NO ACTION");
  });
});

describe("pesquisa sem acento pela coluna normalizada", () => {
  it("normalized_name permite achar 'João' digitando 'joao'", async () => {
    await criarEleitor("C0001", "João da Silva");
    await criarEleitor("C0002", "MARIA JOSÉ");

    const semAcento = await q(
      "select full_name from voters where normalized_name ilike $1 order by full_name",
      ["%joao%"],
    );
    expect(semAcento.map((r) => r.full_name)).toEqual(["João da Silva"]);

    const maiusculas = await q("select full_name from voters where normalized_name ilike $1", [
      "%jose%",
    ]);
    expect(maiusculas.map((r) => r.full_name)).toEqual(["MARIA JOSÉ"]);
  });

  it("matrícula é texto: busca parcial preserva zeros à esquerda", async () => {
    await criarEleitor("001234", "Zero A Esquerda");
    const rows = await q("select registration_number from voters where registration_number ilike $1", [
      "%1234%",
    ]);
    expect(rows.map((r) => r.registration_number)).toEqual(["001234"]);
  });
});
