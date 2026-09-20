import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  pool,
  resetDatabase,
  createTestElection,
  releaseVoting,
  createPosition,
  createCandidate,
  createVoter,
  validateVoter,
  castBallot,
  closeVoting,
} from "./db";

/**
 * Os FATOS de banco que distinguem uma vaga vazia de outra.
 *
 * A tela usava `vagas − eleitos` e chamava a diferença de "sem candidato".
 * Este arquivo prova, contra o banco, que a mesma diferença aparece em
 * três situações diferentes — e qual registro distingue cada uma. A
 * tradução desses fatos em texto é verificada em
 * `tests/unit/seat-gaps.test.ts` (o banco de integração não carrega o
 * runtime do Next, então as libs da aplicação não são importáveis aqui).
 */
async function q(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(sql, params);
  return rows as Record<string, unknown>[];
}

async function votar(
  electionId: string,
  nome: string,
  escolhas: { positionId: string; candidateId: string }[],
) {
  const voter = await createVoter(nome);
  const sessao = await validateVoter(electionId, voter.registrationNumber, nome);
  if (sessao.status !== "ok") throw new Error(`inesperado: ${sessao.status}`);
  await castBallot(sessao.token!, {
    positions: escolhas.map((e) => ({
      position_id: e.positionId,
      allocations: [{ candidate_id: e.candidateId, is_null_vote: false, quantity: 1 }],
    })),
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("F — cargo sem candidatura não gera snapshot", () => {
  it("3 vagas, nenhuma candidatura: zero linhas, cargo continua existindo", async () => {
    const electionId = await createTestElection();
    const vazio = await createPosition({ vacancies: 3, votesPerVoter: 3, slug: "vazio" });
    const outro = await createPosition({ vacancies: 1, votesPerVoter: 1, slug: "com-disputa" });
    const a = await createCandidate("Alguem A", [outro.id]);
    await createCandidate("Alguem B", [outro.id]);
    await releaseVoting(electionId);

    await votar(electionId, "Eleitor F1", [{ positionId: outro.id, candidateId: a }]);
    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    // É por isso que agrupar só snapshots fazia o cargo sumir da revisão.
    expect(
      await q(`select 1 from result_snapshots where election_id = $1 and position_id = $2`, [
        electionId,
        vazio.id,
      ]),
    ).toHaveLength(0);

    const [cargo] = await q(`select vacancies, active from positions where id = $1`, [vazio.id]);
    expect(cargo).toMatchObject({ vacancies: 3, active: true });
  });
});

describe("G — os três fatos que distinguem a causa", () => {
  it("empate pendente: vagas − eleitos = 1, com tie_break_needed marcado", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 1, votesPerVoter: 1, slug: "empatado" });
    const a = await createCandidate("Empate A", [pos.id]);
    const b = await createCandidate("Empate B", [pos.id]);
    await releaseVoting(electionId);

    await votar(electionId, "Eleitor G1", [{ positionId: pos.id, candidateId: a }]);
    await votar(electionId, "Eleitor G2", [{ positionId: pos.id, candidateId: b }]);
    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    const linhas = await q(
      `select elected, tie_break_needed from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is not null`,
      [electionId, pos.id],
    );
    expect(linhas.filter((l) => l.elected)).toHaveLength(0);
    expect(linhas.filter((l) => l.tie_break_needed)).toHaveLength(2);
    // Mesma diferença de um cargo deserto — e havia DOIS candidatos.
    expect(1 - linhas.filter((l) => l.elected).length).toBe(1);
  });

  it("cargo duplo sem promoção: seat_reassignments com promoted_candidate_id nulo", async () => {
    // X concorre nos dois cargos. M tem só X (eleito sem disputa); P tem X
    // e Y (X vence por voto). Ao escolher P, M fica vago — e não há
    // candidato remanescente em M para promover.
    const electionId = await createTestElection();
    const posP = await createPosition({ vacancies: 1, votesPerVoter: 1, slug: "duplo-p" });
    const posM = await createPosition({ vacancies: 1, votesPerVoter: 1, slug: "duplo-m" });

    const x = await createCandidate("Duplo X", [posP.id, posM.id]);
    await createCandidate("Perde P", [posP.id]);
    await releaseVoting(electionId);

    await votar(electionId, "Eleitor G3", [{ positionId: posP.id, candidateId: x }]);
    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    const [decisao] = await q(
      `select id from position_dual_winner_decisions where election_id = $1 and candidate_id = $2`,
      [electionId, x],
    );
    expect(decisao).toBeDefined();

    await q(`select resolve_dual_winner_decision($1, $2)`, [decisao.id, posP.id]);

    const [reassign] = await q(
      `select promoted_candidate_id from seat_reassignments
        where election_id = $1 and position_id = $2`,
      [electionId, posM.id],
    );
    // O registro que distingue este caso de "faltou candidato".
    expect(reassign).toBeDefined();
    expect(reassign.promoted_candidate_id).toBeNull();

    const eleitos = await q(
      `select count(*)::int as n from result_snapshots
        where election_id = $1 and position_id = $2 and elected = true`,
      [electionId, posM.id],
    );
    expect(eleitos[0].n).toBe(0);

    // E havia candidatura: a linha de X continua lá, só que não eleita.
    const linhas = await q(
      `select count(*)::int as n from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is not null`,
      [electionId, posM.id],
    );
    expect(linhas[0].n).toBe(1);
  });

  it("promoção bem-sucedida NÃO deixa vaga vazia", async () => {
    const electionId = await createTestElection();
    const posP = await createPosition({ vacancies: 1, votesPerVoter: 1, slug: "prom-p" });
    const posM = await createPosition({ vacancies: 1, votesPerVoter: 1, slug: "prom-m" });

    const x = await createCandidate("Prom X", [posP.id, posM.id]);
    const y = await createCandidate("Prom Y", [posM.id]);
    await createCandidate("Prom Z", [posP.id]);
    await releaseVoting(electionId);

    await votar(electionId, "Eleitor G4", [
      { positionId: posP.id, candidateId: x },
      { positionId: posM.id, candidateId: x },
    ]);
    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    const [decisao] = await q(
      `select id from position_dual_winner_decisions where election_id = $1`,
      [electionId],
    );
    await q(`select resolve_dual_winner_decision($1, $2)`, [decisao.id, posP.id]);

    const [reassign] = await q(
      `select promoted_candidate_id from seat_reassignments
        where election_id = $1 and position_id = $2`,
      [electionId, posM.id],
    );
    expect(reassign.promoted_candidate_id).toBe(y);

    const eleitos = await q(
      `select count(*)::int as n from result_snapshots
        where election_id = $1 and position_id = $2 and elected = true`,
      [electionId, posM.id],
    );
    // Uma vaga, um eleito: não há lacuna a explicar.
    expect(eleitos[0].n).toBe(1);
  });

  it("cargo sem disputa com vaga sobrando: eleito unopposed e uma vaga a menos", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 2, votesPerVoter: 2, slug: "sobra" });
    await createCandidate("Unico", [pos.id]);
    await releaseVoting(electionId);

    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    const linhas = await q(
      `select elected, unopposed, tie_break_needed from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is not null`,
      [electionId, pos.id],
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ elected: true, unopposed: true, tie_break_needed: false });

    // Sem reassignment e sem empate: a lacuna é mesmo falta de candidatura.
    expect(
      await q(`select 1 from seat_reassignments where election_id = $1 and position_id = $2`, [
        electionId,
        pos.id,
      ]),
    ).toHaveLength(0);
  });
});

describe("guarda de migração: cargo sem disputa que já recebeu voto", () => {
  it("a apuração PARA em vez de zerar a contagem real", async () => {
    // Reproduz uma eleição que já estava em andamento quando a regra de
    // "cargo sem disputa" passou a valer: 2 candidatos para 2 vagas
    // receberam votos sob a regra antiga. Os votos entram direto na
    // tabela, como dados anteriores à migration.
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 2, votesPerVoter: 2, slug: "historico" });
    const c = await createCandidate("Historico C", [pos.id]);
    await createCandidate("Historico D", [pos.id]);
    await releaseVoting(electionId);

    // Pela regra nova este cargo não tem disputa.
    expect((await q(`select position_is_contested($1) as c`, [pos.id]))[0].c).toBe(false);

    const voter = await createVoter("Eleitor Historico");
    const [ballot] = await q(
      `insert into ballots (election_id, submitted_at) values ($1, now()) returning id`,
      [electionId],
    );
    await q(
      `insert into ballot_choices (ballot_id, position_id, candidate_id, is_null_vote, vote_slot)
       values ($1,$2,$3,false,1), ($1,$2,$3,false,2)`,
      [ballot.id, pos.id, c],
    );
    await q(`insert into audit_vote_links (election_id, voter_id, ballot_id) values ($1,$2,$3)`, [
      electionId,
      voter.id,
      ballot.id,
    ]);

    await closeVoting(electionId);

    // Sem a guarda, a apuração gravaria "eleito sem disputa, 0 votos" para
    // os dois — apagando a contagem real e a ordem que dela deriva.
    await expect(q(`select compute_results($1)`, [electionId])).rejects.toThrow(
      /UNCONTESTED_POSITION_HAS_VOTES/,
    );

    // E não deixa apuração pela metade.
    expect(
      await q(`select 1 from result_snapshots where election_id = $1`, [electionId]),
    ).toHaveLength(0);
    const [eleicao] = await q(`select results_computed_at from elections where id = $1`, [
      electionId,
    ]);
    expect(eleicao.results_computed_at).toBeNull();

    // Os votos continuam intactos: nada é apagado nem convertido.
    expect(
      (await q(`select count(*)::int as n from ballot_choices where position_id = $1`, [pos.id]))[0]
        .n,
    ).toBe(2);
  });

  it("cargo sem disputa e SEM voto nenhum continua sendo apurado normalmente", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 2, votesPerVoter: 2, slug: "limpo" });
    await createCandidate("Limpo A", [pos.id]);
    await createCandidate("Limpo B", [pos.id]);
    await releaseVoting(electionId);

    await closeVoting(electionId);
    await expect(q(`select compute_results($1)`, [electionId])).resolves.toBeDefined();

    const linhas = await q(
      `select elected, unopposed from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is not null`,
      [electionId, pos.id],
    );
    expect(linhas).toHaveLength(2);
    expect(linhas.every((l) => l.elected === true && l.unopposed === true)).toBe(true);
  });
});
