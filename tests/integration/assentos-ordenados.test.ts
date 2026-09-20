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
  type TestPosition,
} from "./db";

/**
 * Cargos com assentos NOMEADOS (Tesouraria, Secretaria).
 *
 * A regra "candidatos <= vagas => sem disputa" não vale para eles: os votos
 * é que definem Primeiro e Segundo. O que distingue esses cargos é
 * `positions.seat_labels`, nunca o slug.
 *
 *   seat_labels IS NOT NULL -> vota se houver ao menos 1 candidato
 *   seat_labels IS NULL     -> vota só quando candidatos > vagas
 */
async function q(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(sql, params);
  return rows as Record<string, unknown>[];
}

/** Cargo com assentos nomeados. */
async function createOrderedPosition(
  slug: string,
  vacancies: number,
  labels: string[],
  votesPerVoter = vacancies,
): Promise<TestPosition> {
  const pos = await createPosition({ slug, vacancies, votesPerVoter });
  await q(`update positions set seat_labels = $2 where id = $1`, [pos.id, labels]);
  return pos;
}

const TESOURARIA = ["Primeiro Tesoureiro", "Segundo Tesoureiro"];
const SECRETARIA = ["Primeiro Secretário", "Segundo Secretário"];

let contador = 0;
async function votar(
  electionId: string,
  posicoes: { positionId: string; allocations: unknown[] }[],
) {
  contador += 1;
  const nome = `Eleitor ${contador} ${Date.now()}`;
  const voter = await createVoter(nome);
  const sessao = await validateVoter(electionId, voter.registrationNumber, nome);
  if (sessao.status !== "ok" || !sessao.token) throw new Error(`inesperado: ${sessao.status}`);
  await castBallot(sessao.token, {
    positions: posicoes.map((p) => ({ position_id: p.positionId, allocations: p.allocations })),
  });
}

/** Distribui `quantidade` votos do eleitor entre candidatos. */
function para(...pares: [string, number][]) {
  return pares.map(([candidateId, quantity]) => ({
    candidate_id: candidateId,
    is_null_vote: false,
    quantity,
  }));
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("quais cargos vão à urna", () => {
  const casos: [string, number, number, boolean, boolean][] = [
    // rótulo, vagas, candidatos, tem seat_labels, vai à urna
    ["Tesouraria 2 vagas / 2 candidatos", 2, 2, true, true],
    ["Tesouraria 2 vagas / 1 candidato", 2, 1, true, true],
    ["Tesouraria 2 vagas / 3 candidatos", 2, 3, true, true],
    ["Secretaria 2 vagas / 2 candidatos", 2, 2, true, true],
    ["cargo ordenado sem candidato", 2, 0, true, false],
    ["Marketing 3 vagas / 3 candidatos", 3, 3, false, false],
    ["Eventos 4 vagas / 2 candidatos", 4, 2, false, false],
    ["Marketing 3 vagas / 4 candidatos", 3, 4, false, true],
    ["Presidente 1 vaga / 1 candidato", 1, 1, false, false],
    ["Presidente 1 vaga / 2 candidatos", 1, 2, false, true],
    ["cargo comum sem candidato", 3, 0, false, false],
  ];

  for (const [rotulo, vagas, candidatos, ordenado, esperado] of casos) {
    it(`${rotulo} -> ${esperado ? "VOTA" : "fora da urna"}`, async () => {
      const electionId = await createTestElection();
      const pos = ordenado
        ? await createOrderedPosition(`ord-${vagas}-${candidatos}`, vagas, TESOURARIA, vagas)
        : await createPosition({ slug: `com-${vagas}-${candidatos}`, vacancies: vagas, votesPerVoter: vagas });

      for (let i = 0; i < candidatos; i += 1) {
        await createCandidate(`Candidato ${i} ${rotulo}`, [pos.id]);
      }

      expect((await q(`select position_requires_voting($1) as r`, [pos.id]))[0].r).toBe(esperado);

      // A cédula tem que concordar com a classificação.
      await releaseVoting(electionId);
      const [urna] = await q(`select get_current_voting_election() as e`);
      const ativa = urna.e as { positions: { position_id: string }[] } | null;
      const naUrna = (ativa?.positions ?? []).some((p) => p.position_id === pos.id);
      expect(naUrna).toBe(esperado);
    });
  }

  it("inativar o único candidato tira o cargo ordenado da urna", async () => {
    const electionId = await createTestElection();
    const pos = await createOrderedPosition("ord-inativa", 2, TESOURARIA);
    const unico = await createCandidate("Unico Ordenado", [pos.id]);

    expect((await q(`select position_requires_voting($1) as r`, [pos.id]))[0].r).toBe(true);

    // Antes de liberar a composição ainda pode mudar.
    await q(`update candidates set active = false where id = $1`, [unico]);
    expect((await q(`select position_requires_voting($1) as r`, [pos.id]))[0].r).toBe(false);

    void electionId;
  });

  it("a regra é a MESMA em cast_ballot: cargo ordenado é exigido na cédula", async () => {
    const electionId = await createTestElection();
    const ordenado = await createOrderedPosition("ord-exigido", 2, TESOURARIA);
    const comum = await createPosition({ slug: "comum-fora", vacancies: 3, votesPerVoter: 3 });

    const a = await createCandidate("Ordenado A", [ordenado.id]);
    const b = await createCandidate("Ordenado B", [ordenado.id]);
    await createCandidate("Comum 1", [comum.id]);
    await createCandidate("Comum 2", [comum.id]);
    await releaseVoting(electionId);

    // Cédula só com o cargo ordenado: aceita (o comum não tem disputa).
    await expect(
      votar(electionId, [{ positionId: ordenado.id, allocations: para([a, 1], [b, 1]) }]),
    ).resolves.toBeUndefined();

    // Omitir o cargo ordenado é recusado.
    await expect(
      votar(electionId, [{ positionId: comum.id, allocations: para([a, 3]) }]),
    ).rejects.toThrow(/INVALID_PAYLOAD/);
  });
});

describe("os votos definem a ordem dos assentos", () => {
  it("Tesouraria 2 vagas / 2 candidatos: mais votado é o Primeiro", async () => {
    const electionId = await createTestElection();
    const pos = await createOrderedPosition("tes-ordem", 2, TESOURARIA);
    const ana = await createCandidate("Ana", [pos.id]);
    const bruno = await createCandidate("Bruno", [pos.id]);
    await releaseVoting(electionId);

    // Ana 3, Bruno 1 (cada eleitor distribui 2 votos).
    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 2]) }]);
    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 1], [bruno, 1]) }]);

    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const linhas = await q(
      `select candidate_name, votes_count, elected, tie_break_needed, seat_label
         from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is not null
        order by votes_count desc`,
      [electionId, pos.id],
    );
    expect(linhas).toEqual([
      { candidate_name: "Ana", votes_count: 3, elected: true, tie_break_needed: false, seat_label: "Primeiro Tesoureiro" },
      { candidate_name: "Bruno", votes_count: 1, elected: true, tie_break_needed: false, seat_label: "Segundo Tesoureiro" },
    ]);
  });

  it("Tesouraria 2 vagas / 1 candidato: ocupa o primeiro assento, segunda vaga vazia", async () => {
    const electionId = await createTestElection();
    const pos = await createOrderedPosition("tes-um", 2, TESOURARIA);
    const ana = await createCandidate("Ana Sozinha", [pos.id]);
    await releaseVoting(electionId);

    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 2]) }]);

    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const linhas = await q(
      `select candidate_name, votes_count, elected, unopposed, seat_label
         from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is not null`,
      [electionId, pos.id],
    );
    expect(linhas).toEqual([
      {
        candidate_name: "Ana Sozinha",
        votes_count: 2,
        elected: true,
        // Houve votação: NÃO é "eleito sem disputa".
        unopposed: false,
        seat_label: "Primeiro Tesoureiro",
      },
    ]);

    // Ninguém é inventado para a segunda vaga.
    const eleitos = await q(
      `select count(*)::int as n from result_snapshots
        where election_id = $1 and position_id = $2 and elected = true`,
      [electionId, pos.id],
    );
    expect(eleitos[0].n).toBe(1);
  });

  it("Secretaria funciona igual — a regra é seat_labels, não o cargo", async () => {
    const electionId = await createTestElection();
    const pos = await createOrderedPosition("sec-ordem", 2, SECRETARIA);
    const carla = await createCandidate("Carla", [pos.id]);
    const diego = await createCandidate("Diego", [pos.id]);
    await releaseVoting(electionId);

    await votar(electionId, [{ positionId: pos.id, allocations: para([carla, 2]) }]);
    await votar(electionId, [{ positionId: pos.id, allocations: para([diego, 1], [carla, 1]) }]);

    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const linhas = await q(
      `select candidate_name, seat_label from result_snapshots
        where election_id = $1 and position_id = $2 and elected = true
        order by votes_count desc`,
      [electionId, pos.id],
    );
    expect(linhas).toEqual([
      { candidate_name: "Carla", seat_label: "Primeiro Secretário" },
      { candidate_name: "Diego", seat_label: "Segundo Secretário" },
    ]);
  });
});

describe("cargo SEM assentos nomeados mantém a regra antiga", () => {
  it("Marketing 3 vagas / 3 candidatos: eleitos sem disputa, sem votação", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ slug: "mkt", vacancies: 3, votesPerVoter: 3 });
    for (const nome of ["Mkt A", "Mkt B", "Mkt C"]) await createCandidate(nome, [pos.id]);
    await releaseVoting(electionId);

    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const linhas = await q(
      `select elected, unopposed, votes_count, seat_label from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is not null`,
      [electionId, pos.id],
    );
    expect(linhas).toHaveLength(3);
    expect(linhas.every((l) => l.elected === true && l.unopposed === true)).toBe(true);
    // Sem seat_labels não há rótulo a atribuir.
    expect(linhas.every((l) => l.seat_label === null)).toBe(true);
  });

  it("Eventos 4 vagas / 2 candidatos: 2 eleitos sem disputa, 2 vagas vazias", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ slug: "evt", vacancies: 4, votesPerVoter: 4 });
    await createCandidate("Evt A", [pos.id]);
    await createCandidate("Evt B", [pos.id]);
    await releaseVoting(electionId);

    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const eleitos = await q(
      `select count(*)::int as n from result_snapshots
        where election_id = $1 and position_id = $2 and elected = true`,
      [electionId, pos.id],
    );
    expect(eleitos[0].n).toBe(2);
  });
});

describe("desempate em cargo ordenado", () => {
  async function criarRunoff(parentId: string, positionIds: string[]) {
    const { rows } = await pool.query(
      `select create_runoff_election($1, $2::uuid[], 'Empate de ordem',
         current_date - 1, current_date + 1, '00:00'::time, '23:59'::time) as id`,
      [parentId, positionIds],
    );
    return rows[0].id as string;
  }

  it("empate que só afeta a ORDEM vira desempate, ainda que os dois sejam eleitos", async () => {
    // Ana 50 x Bruno 50 para 2 vagas: os dois entram de qualquer forma, mas
    // não se sabe quem é Primeiro e quem é Segundo. Sem esta regra os dois
    // sairiam eleitos e o rótulo dependeria da ordem das linhas.
    const electionId = await createTestElection();
    const pos = await createOrderedPosition("tes-empate", 2, TESOURARIA);
    const ana = await createCandidate("Ana Empate", [pos.id]);
    const bruno = await createCandidate("Bruno Empate", [pos.id]);
    await releaseVoting(electionId);

    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 1], [bruno, 1]) }]);
    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 1], [bruno, 1]) }]);

    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const linhas = await q(
      `select candidate_name, votes_count, elected, tie_break_needed, seat_label
         from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is not null
        order by candidate_name`,
      [electionId, pos.id],
    );
    expect(linhas).toEqual([
      { candidate_name: "Ana Empate", votes_count: 2, elected: false, tie_break_needed: true, seat_label: null },
      { candidate_name: "Bruno Empate", votes_count: 2, elected: false, tie_break_needed: true, seat_label: null },
    ]);

    // E a publicação fica bloqueada até resolver.
    await expect(q(`select publish_results($1)`, [electionId])).rejects.toThrow(/TIE_PENDING/);
  });

  it("o desempate de cargo ordenado dá 1 voto por eleitor", async () => {
    const electionId = await createTestElection();
    const pos = await createOrderedPosition("tes-1voto", 2, TESOURARIA);
    const ana = await createCandidate("Ana 1v", [pos.id]);
    const bruno = await createCandidate("Bruno 1v", [pos.id]);
    await releaseVoting(electionId);

    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 1], [bruno, 1]) }]);
    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const runoffId = await criarRunoff(electionId, [pos.id]);
    const [rp] = await q(
      `select vacancies_in_dispute, votes_per_voter from runoff_positions
        where runoff_election_id = $1 and position_id = $2`,
      [runoffId, pos.id],
    );
    // 2 vagas em disputa, mas UM voto: ali se escolhe uma ordem, não um
    // conjunto. Dois votos permitiriam votar nos dois e não decidir nada.
    expect(rp).toEqual({ vacancies_in_dispute: 2, votes_per_voter: 1 });

    // A urna do desempate reflete isso.
    const [urna] = await q(`select get_current_voting_election() as e`);
    const ativa = urna.e as { type: string; positions: { votes_per_voter: number }[] };
    expect(ativa.type).toBe("runoff");
    expect(ativa.positions[0].votes_per_voter).toBe(1);

    void bruno;
  });

  it("o desempate resolve a ordem: mais votado vira Primeiro", async () => {
    const electionId = await createTestElection();
    const pos = await createOrderedPosition("tes-resolve", 2, TESOURARIA);
    const ana = await createCandidate("Ana R", [pos.id]);
    const bruno = await createCandidate("Bruno R", [pos.id]);
    await releaseVoting(electionId);

    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 1], [bruno, 1]) }]);
    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const runoffId = await criarRunoff(electionId, [pos.id]);

    // 3 eleitores, 1 voto cada: Ana 2, Bruno 1.
    await votar(runoffId, [{ positionId: pos.id, allocations: para([ana, 1]) }]);
    await votar(runoffId, [{ positionId: pos.id, allocations: para([ana, 1]) }]);
    await votar(runoffId, [{ positionId: pos.id, allocations: para([bruno, 1]) }]);

    await q(`update elections set voting_closed_manually_at = now() where id = $1`, [runoffId]);
    await q(`select compute_results($1)`, [runoffId]);
    await q(`select publish_results($1)`, [runoffId]);

    const linhas = await q(
      `select candidate_name, elected, tie_break_needed, seat_label from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is not null
        order by candidate_name`,
      [electionId, pos.id],
    );
    expect(linhas).toEqual([
      { candidate_name: "Ana R", elected: true, tie_break_needed: false, seat_label: "Primeiro Tesoureiro" },
      { candidate_name: "Bruno R", elected: true, tie_break_needed: false, seat_label: "Segundo Tesoureiro" },
    ]);
  });

  it("empate PARCIAL não reabre o assento já definido", async () => {
    // Ana 4 (Primeiro, definido). Bruno 2 e Carlos 2 disputam só o Segundo.
    const electionId = await createTestElection();
    const pos = await createOrderedPosition("tes-parcial", 2, TESOURARIA);
    const ana = await createCandidate("Ana P", [pos.id]);
    const bruno = await createCandidate("Bruno P", [pos.id]);
    const carlos = await createCandidate("Carlos P", [pos.id]);
    await releaseVoting(electionId);

    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 2]) }]);
    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 2]) }]);
    await votar(electionId, [{ positionId: pos.id, allocations: para([bruno, 2]) }]);
    await votar(electionId, [{ positionId: pos.id, allocations: para([carlos, 2]) }]);

    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const [anaRow] = await q(
      `select elected, tie_break_needed, seat_label from result_snapshots
        where election_id = $1 and candidate_id = $2`,
      [electionId, ana],
    );
    expect(anaRow).toEqual({
      elected: true,
      tie_break_needed: false,
      seat_label: "Primeiro Tesoureiro",
    });

    const runoffId = await criarRunoff(electionId, [pos.id]);
    const [rp] = await q(
      `select vacancies_in_dispute, votes_per_voter from runoff_positions
        where runoff_election_id = $1`,
      [runoffId],
    );
    // Só o Segundo está em jogo — e com 1 voto por eleitor.
    expect(rp).toEqual({ vacancies_in_dispute: 1, votes_per_voter: 1 });

    // Ana não entra no desempate.
    const disputantes = await q(
      `select candidate_id from runoff_candidates where runoff_election_id = $1`,
      [runoffId],
    );
    expect(disputantes.map((d) => d.candidate_id).sort()).toEqual([bruno, carlos].sort());

    await votar(runoffId, [{ positionId: pos.id, allocations: para([carlos, 1]) }]);
    await q(`update elections set voting_closed_manually_at = now() where id = $1`, [runoffId]);
    await q(`select compute_results($1)`, [runoffId]);
    await q(`select publish_results($1)`, [runoffId]);

    const finais = await q(
      `select candidate_name, elected, seat_label from result_snapshots
        where election_id = $1 and elected = true and candidate_id is not null
        order by seat_label`,
      [electionId],
    );
    expect(finais).toEqual([
      { candidate_name: "Ana P", elected: true, seat_label: "Primeiro Tesoureiro" },
      { candidate_name: "Carlos P", elected: true, seat_label: "Segundo Tesoureiro" },
    ]);
  });

  it("empate repetido no desempate permite nova rodada", async () => {
    const electionId = await createTestElection();
    const pos = await createOrderedPosition("tes-repete", 2, TESOURARIA);
    const ana = await createCandidate("Ana RR", [pos.id]);
    const bruno = await createCandidate("Bruno RR", [pos.id]);
    await releaseVoting(electionId);

    await votar(electionId, [{ positionId: pos.id, allocations: para([ana, 1], [bruno, 1]) }]);
    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const runoff1 = await criarRunoff(electionId, [pos.id]);
    // Empata de novo: 1 para cada.
    await votar(runoff1, [{ positionId: pos.id, allocations: para([ana, 1]) }]);
    await votar(runoff1, [{ positionId: pos.id, allocations: para([bruno, 1]) }]);
    await q(`update elections set voting_closed_manually_at = now() where id = $1`, [runoff1]);
    await q(`select compute_results($1)`, [runoff1]);

    const pendentes = await q(
      `select count(*)::int as n from result_snapshots
        where election_id = $1 and tie_break_needed = true`,
      [runoff1],
    );
    expect(pendentes[0].n).toBe(2);

    // Não resolve sozinho: a rodada seguinte é do administrador.
    await expect(q(`select publish_results($1)`, [runoff1])).rejects.toThrow(/TIE_PENDING/);
  });

  it("cargo SEM assentos nomeados preserva votes_per_voter = vagas em disputa", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ slug: "comum-runoff", vacancies: 2, votesPerVoter: 2 });
    const a = await createCandidate("Comum A", [pos.id]);
    const b = await createCandidate("Comum B", [pos.id]);
    const c = await createCandidate("Comum C", [pos.id]);
    await releaseVoting(electionId);

    // Empate triplo para 2 vagas: todos com 2 votos.
    await votar(electionId, [{ positionId: pos.id, allocations: para([a, 1], [b, 1]) }]);
    await votar(electionId, [{ positionId: pos.id, allocations: para([c, 1], [a, 1]) }]);
    await votar(electionId, [{ positionId: pos.id, allocations: para([b, 1], [c, 1]) }]);

    await closeVoting(electionId);
    await q(`select compute_results($1)`, [electionId]);

    const runoffId = await criarRunoff(electionId, [pos.id]);
    const [rp] = await q(
      `select vacancies_in_dispute, votes_per_voter from runoff_positions
        where runoff_election_id = $1`,
      [runoffId],
    );
    // Regra inalterada para cargo comum.
    expect(rp).toEqual({ vacancies_in_dispute: 2, votes_per_voter: 2 });
  });
});
