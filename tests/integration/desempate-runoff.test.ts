import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  pool,
  resetDatabase,
  createTestElection,
  createPosition,
  createCandidate,
  createVoter,
  closeVoting,
  voteAs,
  singleChoice,
} from "./db";

/**
 * Ciclo completo de desempate (etapa 2A).
 *
 * Antes desta etapa o desempate era criado e apurado, mas NADA resolvia o
 * empate da eleição principal: publish_results(pai) levantava TIE_PENDING
 * para sempre. O teste central aqui é justamente o que faltava — o
 * desempate publicado destrava o pai, preservando os votos originais.
 */

type Row = Record<string, unknown>;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function computeResults(electionId: string) {
  await pool.query("select compute_results($1)", [electionId]);
}

async function publishResults(electionId: string) {
  await pool.query("select publish_results($1)", [electionId]);
}

async function createRunoff(
  parentId: string,
  positionIds: string[],
  reason = "Empate",
): Promise<string> {
  const { rows } = await pool.query(
    `select create_runoff_election($1, $2::uuid[], $3,
       current_date - 1, current_date + 1, '00:00'::time, '23:59'::time) as id`,
    [parentId, positionIds, reason],
  );
  return rows[0].id as string;
}

async function snapshots(electionId: string, positionId?: string): Promise<Row[]> {
  return q(
    `select candidate_id, candidate_name, votes_count, rank, elected, tie_break_needed, seat_label
     from result_snapshots
     where election_id = $1 and ($2::uuid is null or position_id = $2)
     order by votes_count desc, candidate_name`,
    [electionId, positionId ?? null],
  );
}

/** Empate 2x2 num cargo de 1 vaga, com 1 nulo — o cenário da simulação. */
async function setupTiedElection() {
  const electionId = await createTestElection();
  const position = await createPosition({ vacancies: 1, votesPerVoter: 1 });
  const ana = await createCandidate("Ana Monteiro", [position.id]);
  const bruno = await createCandidate("Bruno Tavares", [position.id]);

  const voters = [];
  for (let i = 1; i <= 5; i += 1) voters.push(await createVoter(`Eleitor ${i}`));

  await voteAs(electionId, voters[0].registrationNumber, "Eleitor 1", singleChoice(position.id, ana));
  await voteAs(electionId, voters[1].registrationNumber, "Eleitor 2", singleChoice(position.id, ana));
  await voteAs(electionId, voters[2].registrationNumber, "Eleitor 3", singleChoice(position.id, bruno));
  await voteAs(electionId, voters[3].registrationNumber, "Eleitor 4", singleChoice(position.id, bruno));
  await voteAs(electionId, voters[4].registrationNumber, "Eleitor 5", singleChoice(position.id, null));

  await closeVoting(electionId);
  await computeResults(electionId);

  return { electionId, position, ana, bruno, voters };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("detecção do empate", () => {
  it("marca tie_break_needed nos dois empatados na linha de corte", async () => {
    const { electionId, position } = await setupTiedElection();
    const rows = await snapshots(electionId, position.id);
    const candidatos = rows.filter((r) => r.candidate_id !== null);

    expect(candidatos).toHaveLength(2);
    for (const row of candidatos) {
      expect(row.votes_count).toBe(2);
      expect(row.rank).toBe(1);
      expect(row.tie_break_needed).toBe(true);
      expect(row.elected).toBe(false);
    }
  });

  it("bloqueia a publicação da eleição principal", async () => {
    const { electionId } = await setupTiedElection();
    await expect(publishResults(electionId)).rejects.toThrow(/TIE_PENDING/);
  });

  it("empate FORA da linha de corte não vira pendência", async () => {
    // 2 vagas, 3 candidatos: 3, 1, 1 — o empate é pela 3ª colocação, que
    // não disputa vaga nenhuma.
    const electionId = await createTestElection();
    const position = await createPosition({ vacancies: 2, votesPerVoter: 2 });
    const a = await createCandidate("Primeira", [position.id]);
    const b = await createCandidate("Segunda", [position.id]);
    const c = await createCandidate("Terceira", [position.id]);

    const alloc = (x: string, y: string) => ({
      positions: [
        {
          position_id: position.id,
          allocations: [
            { candidate_id: x, is_null_vote: false, quantity: 1 },
            { candidate_id: y, is_null_vote: false, quantity: 1 },
          ],
        },
      ],
    });

    for (let i = 1; i <= 2; i += 1) {
      const v = await createVoter(`E${i}`);
      await voteAs(electionId, v.registrationNumber, `E${i}`, alloc(a, b));
    }
    const v3 = await createVoter("E3");
    await voteAs(electionId, v3.registrationNumber, "E3", alloc(a, c));

    await closeVoting(electionId);
    await computeResults(electionId);

    const rows = await snapshots(electionId, position.id);
    expect(rows.some((r) => r.tie_break_needed === true)).toBe(false);
    await expect(publishResults(electionId)).resolves.toBeUndefined();
  });
});

describe("criação do desempate", () => {
  it("deriva do banco apenas os candidatos realmente empatados", async () => {
    const { electionId, position, ana, bruno } = await setupTiedElection();
    const outro = await createCandidate("Nao Empatado", [position.id]);

    const runoffId = await createRunoff(electionId, [position.id]);
    const rows = await q(
      "select candidate_id from runoff_candidates where runoff_election_id = $1",
      [runoffId],
    );
    const ids = rows.map((r) => r.candidate_id);

    expect(ids).toHaveLength(2);
    expect(ids).toContain(ana);
    expect(ids).toContain(bruno);
    expect(ids).not.toContain(outro);
  });

  it("deriva as vagas em disputa: 1 vaga, 2 empatados", async () => {
    const { electionId, position } = await setupTiedElection();
    const runoffId = await createRunoff(electionId, [position.id]);

    const [row] = await q(
      "select vacancies_in_dispute, votes_per_voter from runoff_positions where runoff_election_id = $1",
      [runoffId],
    );
    expect(row.vacancies_in_dispute).toBe(1);
    expect(row.votes_per_voter).toBe(1);
  });

  it("deriva as vagas em disputa quando parte do cargo já está definida", async () => {
    // 3 vagas, 4 candidatos: 5, 2, 2, 2 -> o primeiro está eleito e os
    // outros três disputam as 2 vagas restantes. O valor precisa sair da
    // apuração, não de um número digitado pelo administrador.
    const electionId = await createTestElection();
    const position = await createPosition({ vacancies: 3, votesPerVoter: 3 });
    const lider = await createCandidate("Lider", [position.id]);
    const a = await createCandidate("Empatado A", [position.id]);
    const b = await createCandidate("Empatado B", [position.id]);
    const c = await createCandidate("Empatado C", [position.id]);

    const ballot = (segundo: string, terceiro: string) => ({
      positions: [
        {
          position_id: position.id,
          allocations: [
            { candidate_id: lider, is_null_vote: false, quantity: 1 },
            { candidate_id: segundo, is_null_vote: false, quantity: 1 },
            { candidate_id: terceiro, is_null_vote: false, quantity: 1 },
          ],
        },
      ],
    });

    // 6 eleitores x 3 votos: o líder recebe 6 e a, b, c ficam com 4 cada —
    // empate triplo exatamente nas 2 vagas restantes.
    const pares: [string, string][] = [
      [a, b],
      [b, c],
      [c, a],
      [a, b],
      [b, c],
      [c, a],
    ];
    for (let i = 0; i < 6; i += 1) {
      const v = await createVoter(`V${i}`);
      await voteAs(electionId, v.registrationNumber, `V${i}`, ballot(pares[i][0], pares[i][1]));
    }

    await closeVoting(electionId);
    await computeResults(electionId);

    const rows = await snapshots(electionId, position.id);
    const eleitos = rows.filter((r) => r.elected === true);
    const empatados = rows.filter((r) => r.tie_break_needed === true);
    expect(eleitos).toHaveLength(1);
    expect(eleitos[0].candidate_id).toBe(lider);
    expect(empatados).toHaveLength(3);

    const runoffId = await createRunoff(electionId, [position.id]);
    const [rp] = await q(
      "select vacancies_in_dispute, votes_per_voter from runoff_positions where runoff_election_id = $1",
      [runoffId],
    );
    // 3 vagas - 1 já eleito = 2 em disputa, e 2 votos por eleitor.
    expect(rp.vacancies_in_dispute).toBe(2);
    expect(rp.votes_per_voter).toBe(2);

    // e o líder já eleito NÃO participa do desempate
    const ids = (
      await q("select candidate_id from runoff_candidates where runoff_election_id = $1", [runoffId])
    ).map((r) => r.candidate_id);
    expect(ids).not.toContain(lider);
  });

  it("recusa cargo sem empate", async () => {
    const { electionId } = await setupTiedElection();
    const outroCargo = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    await expect(createRunoff(electionId, [outroCargo.id])).rejects.toThrow(/NO_TIE_FOR_POSITION/);
  });

  it("recusa criar um segundo desempate para o mesmo empate", async () => {
    const { electionId, position } = await setupTiedElection();
    await createRunoff(electionId, [position.id]);
    await expect(createRunoff(electionId, [position.id])).rejects.toThrow(/RUNOFF_ALREADY_EXISTS/);
  });

  it("bloqueia duplicação mesmo em criações concorrentes", async () => {
    const { electionId, position } = await setupTiedElection();

    // Duas transações simultâneas — o índice parcial é o árbitro, não o botão.
    const results = await Promise.allSettled([
      createRunoff(electionId, [position.id]),
      createRunoff(electionId, [position.id]),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);

    const [{ count }] = await q(
      "select count(*)::int as count from elections where parent_election_id = $1",
      [electionId],
    );
    expect(count).toBe(1);
  });

  it("recusa desempate numa eleição ainda não apurada", async () => {
    const electionId = await createTestElection();
    const position = await createPosition();
    await expect(createRunoff(electionId, [position.id])).rejects.toThrow(/RESULTS_NOT_COMPUTED/);
  });
});

describe("votação do desempate", () => {
  it("quem votou na eleição principal vota de novo no desempate", async () => {
    const { electionId, position, ana, voters } = await setupTiedElection();
    const runoffId = await createRunoff(electionId, [position.id]);

    await expect(
      voteAs(runoffId, voters[0].registrationNumber, "Eleitor 1", singleChoice(position.id, ana)),
    ).resolves.toBeUndefined();
  });

  it("o mesmo eleitor não vota duas vezes no mesmo desempate", async () => {
    const { electionId, position, ana, voters } = await setupTiedElection();
    const runoffId = await createRunoff(electionId, [position.id]);

    await voteAs(runoffId, voters[0].registrationNumber, "Eleitor 1", singleChoice(position.id, ana));
    await expect(
      voteAs(runoffId, voters[0].registrationNumber, "Eleitor 1", singleChoice(position.id, ana)),
    ).rejects.toThrow(/already_voted/);
  });

  it("rejeita voto em candidato que não está no desempate", async () => {
    const { electionId, position, voters } = await setupTiedElection();
    const intruso = await createCandidate("Intruso", [position.id]);
    const runoffId = await createRunoff(electionId, [position.id]);

    await expect(
      voteAs(runoffId, voters[0].registrationNumber, "Eleitor 1", singleChoice(position.id, intruso)),
    ).rejects.toThrow(/INVALID_CANDIDATE/);
  });

  it("rejeita cédula com cargo que não está em disputa", async () => {
    const { electionId, position, ana, voters } = await setupTiedElection();
    const outroCargo = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    const runoffId = await createRunoff(electionId, [position.id]);

    await expect(
      voteAs(runoffId, voters[0].registrationNumber, "Eleitor 1", singleChoice(outroCargo.id, ana)),
    ).rejects.toThrow(/INVALID_PAYLOAD/);
  });

  it("aceita voto nulo, como na eleição geral", async () => {
    const { electionId, position, voters } = await setupTiedElection();
    const runoffId = await createRunoff(electionId, [position.id]);

    await expect(
      voteAs(runoffId, voters[0].registrationNumber, "Eleitor 1", singleChoice(position.id, null)),
    ).resolves.toBeUndefined();
  });

  it("uma sessão da eleição geral não serve para votar no desempate", async () => {
    const { electionId, position, ana, voters } = await setupTiedElection();
    const runoffId = await createRunoff(electionId, [position.id]);

    // Sessão emitida para a GERAL (que já encerrou) — cast_ballot valida o
    // status da eleição da sessão, não a do payload.
    const { rows } = await pool.query(`select validate_voter($1, $2, $3) as r`, [
      electionId,
      voters[0].registrationNumber,
      "Eleitor 1",
    ]);
    expect(rows[0].r.status).not.toBe("ok");
    expect(runoffId).toBeTruthy();
    expect(ana).toBeTruthy();
  });
});

describe("resolução do empate da eleição principal", () => {
  async function runFullCycle() {
    const base = await setupTiedElection();
    const runoffId = await createRunoff(base.electionId, [base.position.id]);

    // Ana 3 x Bruno 2
    const escolhas = [base.ana, base.ana, base.ana, base.bruno, base.bruno];
    for (let i = 0; i < 5; i += 1) {
      await voteAs(
        runoffId,
        base.voters[i].registrationNumber,
        `Eleitor ${i + 1}`,
        singleChoice(base.position.id, escolhas[i]),
      );
    }
    await closeVoting(runoffId);
    await computeResults(runoffId);
    return { ...base, runoffId };
  }

  it("publicar o desempate resolve o empate do pai", async () => {
    const { electionId, position, ana, bruno, runoffId } = await runFullCycle();
    await publishResults(runoffId);

    const rows = await snapshots(electionId, position.id);
    const rowAna = rows.find((r) => r.candidate_id === ana)!;
    const rowBruno = rows.find((r) => r.candidate_id === bruno)!;

    expect(rowAna.elected).toBe(true);
    expect(rowAna.tie_break_needed).toBe(false);
    expect(rowBruno.elected).toBe(false);
    expect(rowBruno.tie_break_needed).toBe(false);
  });

  it("preserva os votos da eleição original (2 x 2)", async () => {
    const { electionId, position, ana, bruno, runoffId } = await runFullCycle();
    await publishResults(runoffId);

    const rows = await snapshots(electionId, position.id);
    expect(rows.find((r) => r.candidate_id === ana)!.votes_count).toBe(2);
    expect(rows.find((r) => r.candidate_id === bruno)!.votes_count).toBe(2);
  });

  it("preserva os votos do desempate (3 x 2) como registro separado", async () => {
    const { position, ana, bruno, runoffId } = await runFullCycle();
    await publishResults(runoffId);

    const rows = await snapshots(runoffId, position.id);
    expect(rows.find((r) => r.candidate_id === ana)!.votes_count).toBe(3);
    expect(rows.find((r) => r.candidate_id === bruno)!.votes_count).toBe(2);
  });

  it("registra a resolução de forma auditável", async () => {
    const { electionId, position, ana, runoffId } = await runFullCycle();
    await publishResults(runoffId);

    const [row] = await q(
      `select parent_election_id, runoff_election_id, position_id, candidate_id, votes_in_runoff
       from runoff_resolutions where parent_election_id = $1`,
      [electionId],
    );
    expect(row).toMatchObject({
      parent_election_id: electionId,
      runoff_election_id: runoffId,
      position_id: position.id,
      candidate_id: ana,
      votes_in_runoff: 3,
    });
  });

  it("destrava a publicação da eleição principal", async () => {
    const { electionId, runoffId } = await runFullCycle();
    await expect(publishResults(electionId)).rejects.toThrow(/RUNOFF_PENDING|TIE_PENDING/);

    await publishResults(runoffId);
    await expect(publishResults(electionId)).resolves.toBeUndefined();

    const [row] = await q("select results_published_at from elections where id = $1", [electionId]);
    expect(row.results_published_at).not.toBeNull();
  });

  it("marca o cargo do desempate como resolvido", async () => {
    const { runoffId } = await runFullCycle();
    await publishResults(runoffId);

    const [row] = await q(
      "select resolved_at from runoff_positions where runoff_election_id = $1",
      [runoffId],
    );
    expect(row.resolved_at).not.toBeNull();
  });
});

describe("novo empate dentro do desempate", () => {
  it("NÃO escolhe vencedor automaticamente", async () => {
    const base = await setupTiedElection();
    const runoffId = await createRunoff(base.electionId, [base.position.id]);

    // 2 x 2 de novo (o quinto vota nulo)
    const escolhas = [base.ana, base.ana, base.bruno, base.bruno, null];
    for (let i = 0; i < 5; i += 1) {
      await voteAs(
        runoffId,
        base.voters[i].registrationNumber,
        `Eleitor ${i + 1}`,
        singleChoice(base.position.id, escolhas[i]),
      );
    }
    await closeVoting(runoffId);
    await computeResults(runoffId);

    const rows = await snapshots(runoffId, base.position.id);
    expect(rows.filter((r) => r.tie_break_needed === true)).toHaveLength(2);
    expect(rows.some((r) => r.elected === true)).toBe(false);

    await expect(publishResults(runoffId)).rejects.toThrow(/TIE_PENDING/);

    // e o pai continua intocado
    const pai = await snapshots(base.electionId, base.position.id);
    for (const row of pai.filter((r) => r.candidate_id !== null)) {
      expect(row.tie_break_needed).toBe(true);
      expect(row.elected).toBe(false);
    }
  });

  it("permite criar uma rodada seguinte, filha do desempate empatado", async () => {
    const base = await setupTiedElection();
    const runoff1 = await createRunoff(base.electionId, [base.position.id]);

    const escolhas = [base.ana, base.ana, base.bruno, base.bruno, null];
    for (let i = 0; i < 5; i += 1) {
      await voteAs(
        runoff1,
        base.voters[i].registrationNumber,
        `Eleitor ${i + 1}`,
        singleChoice(base.position.id, escolhas[i]),
      );
    }
    await closeVoting(runoff1);
    await computeResults(runoff1);

    const runoff2 = await createRunoff(runoff1, [base.position.id], "Segunda rodada");
    const [row] = await q(
      "select parent_election_id, vacancies_in_dispute from runoff_positions where runoff_election_id = $1",
      [runoff2],
    );
    expect(row.parent_election_id).toBe(runoff1);
    expect(row.vacancies_in_dispute).toBe(1);
  });
});

describe("eleição ativa (get_current_voting_election)", () => {
  it("devolve o desempate quando ele é a votação aberta", async () => {
    const { electionId, position } = await setupTiedElection();
    const runoffId = await createRunoff(electionId, [position.id]);

    const [row] = await q("select get_current_voting_election() as e");
    const active = row.e as Record<string, unknown>;
    expect(active.election_id).toBe(runoffId);
    expect(active.type).toBe("runoff");
    expect(active.parent_election_id).toBe(electionId);
    expect(active.positions).toHaveLength(1);
  });

  it("devolve a eleição geral enquanto a votação dela está aberta", async () => {
    const electionId = await createTestElection();
    await createPosition({ vacancies: 1, votesPerVoter: 1 });

    const [row] = await q("select get_current_voting_election() as e");
    const active = row.e as Record<string, unknown>;
    expect(active.election_id).toBe(electionId);
    expect(active.type).toBe("general");
  });

  it("devolve null quando não há votação aberta", async () => {
    const { electionId } = await setupTiedElection();
    expect(electionId).toBeTruthy();
    const [row] = await q("select get_current_voting_election() as e");
    expect(row.e).toBeNull();
  });
});

describe("estado ao vivo acompanha a votação aberta", () => {
  it("durante o desempate, a home recebe o status DELE, não o da geral", async () => {
    const { electionId, position } = await setupTiedElection();
    const runoffId = await createRunoff(electionId, [position.id]);

    const [row] = await q("select get_live_election_state($1) as s", [electionId]);
    const state = row.s as Record<string, unknown>;

    // A geral, sozinha, estaria em 'desempate_necessario' — status correto
    // sobre ela, mas que não levava ninguém à urna.
    expect(state.status).toBe("votacao_desempate");
    expect(state.active_election_id).toBe(runoffId);
    expect(state.participation).not.toBeNull();
  });

  it("sem votação aberta, devolve o status da própria eleição", async () => {
    const { electionId } = await setupTiedElection();
    const [row] = await q("select get_live_election_state($1) as s", [electionId]);
    const state = row.s as Record<string, unknown>;

    expect(state.status).toBe("desempate_necessario");
    expect(state.active_election_id).toBeNull();
    expect(state.participation).toBeNull();
  });

  it("não expõe nada além de status, participação, hora e eleição ativa", async () => {
    const { electionId } = await setupTiedElection();
    const [row] = await q("select get_live_election_state($1) as s", [electionId]);
    expect(Object.keys(row.s as object).sort()).toEqual([
      "active_election_id",
      "participation",
      "server_time",
      "status",
    ]);
  });
});

describe("origem da eleição no resultado público", () => {
  it("runoff_resolutions fica legível quando a eleição principal é publicada", async () => {
    const base = await setupTiedElection();
    const runoffId = await createRunoff(base.electionId, [base.position.id]);
    const escolhas = [base.ana, base.ana, base.ana, base.bruno, base.bruno];
    for (let i = 0; i < 5; i += 1) {
      await voteAs(
        runoffId,
        base.voters[i].registrationNumber,
        `Eleitor ${i + 1}`,
        singleChoice(base.position.id, escolhas[i]),
      );
    }
    await closeVoting(runoffId);
    await computeResults(runoffId);
    await publishResults(runoffId);

    const client = await pool.connect();
    try {
      // antes de publicar a principal: invisível para o público
      await client.query("begin");
      await client.query("set local role anon");
      const antes = await client.query("select * from runoff_resolutions");
      await client.query("commit");
      expect(antes.rows).toHaveLength(0);
    } finally {
      client.release();
    }

    await publishResults(base.electionId);

    const client2 = await pool.connect();
    try {
      await client2.query("begin");
      await client2.query("set local role anon");
      const depois = await client2.query("select candidate_id, votes_in_runoff from runoff_resolutions");
      await client2.query("commit");
      expect(depois.rows).toHaveLength(1);
      expect(depois.rows[0].candidate_id).toBe(base.ana);
      expect(depois.rows[0].votes_in_runoff).toBe(3);
    } finally {
      client2.release();
    }
  });
});

describe("permissões das funções novas", () => {
  async function callAs(role: string, sql: string, params: unknown[] = []) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${role}`);
      const { rows } = await client.query(sql, params);
      await client.query("commit");
      return rows;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  it("get_current_voting_election é pública (a urna precisa dela)", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      await expect(callAs(role, "select get_current_voting_election() as e")).resolves.toBeTruthy();
    }
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role} não executa create_runoff_election`, async () => {
      await expect(
        callAs(
          role,
          `select create_runoff_election($1, $2::uuid[], 'x', current_date, current_date, '00:00'::time, '23:59'::time)`,
          ["11111111-1111-4111-8111-111111111111", []],
        ),
      ).rejects.toThrow(/permission denied for function create_runoff_election/);
    });

    it(`${role} não executa resolve_parent_ties_from_runoff`, async () => {
      await expect(
        callAs(role, "select resolve_parent_ties_from_runoff($1)", [
          "11111111-1111-4111-8111-111111111111",
        ]),
      ).rejects.toThrow(/permission denied for function resolve_parent_ties_from_runoff/);
    });
  }
});
