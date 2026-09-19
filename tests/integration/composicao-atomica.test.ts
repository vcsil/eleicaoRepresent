import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  pool,
  resetDatabase,
  createTestElection,
  createUnreleasedElection,
  createPosition,
  createCandidate,
  createVoter,
  validateVoter,
  castBallot,
  type TestPosition,
} from "./db";

/**
 * Gravação de candidato: uma transação, um lock.
 *
 * Antes, a Server Action fazia três idas ao banco — ler o congelamento,
 * apagar os vínculos, recriá-los — e cada intervalo entre elas era uma
 * janela real:
 *
 *  B. `[A,B]` contra `[A,A]` tem o mesmo tamanho e todo item enviado
 *     pertence ao conjunto original, então passava pela comparação. O
 *     INSERT quebrava no índice único, mas o DELETE já tinha apagado os
 *     vínculos: o candidato ficava sem cargo nenhum.
 *  C. Trocar só a apresentação também apagava e recriava os vínculos. Se
 *     o cargo tinha exatamente um candidato a mais que vagas, nesse
 *     intervalo ele deixava de ter disputa e saía da cédula — e o banco
 *     aceitava uma cédula sem ele.
 *  D. A liberação da votação podia acontecer entre a leitura do
 *     congelamento e a escrita.
 */
async function q(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(sql, params);
  return rows as Record<string, unknown>[];
}

/** `save_candidate` com valores informativos neutros. */
async function salvar(
  candidateId: string | null,
  overrides: Partial<{
    full_name: string;
    tagline: string | null;
    presentation: string | null;
    proposals: string | null;
    video_url: string | null;
    active: boolean;
    display_order: number;
    position_ids: string[];
    photo_path: string | null;
  }> = {},
) {
  const campos = {
    full_name: "Candidato Base",
    tagline: null,
    presentation: null,
    proposals: null,
    video_url: null,
    active: true,
    display_order: 1,
    position_ids: [] as string[],
    photo_path: null,
    ...overrides,
  };
  const { rows } = await pool.query(
    `select save_candidate($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id`,
    [
      candidateId,
      campos.full_name,
      campos.tagline,
      campos.presentation,
      campos.proposals,
      campos.video_url,
      campos.active,
      campos.display_order,
      campos.position_ids,
      campos.photo_path,
    ],
  );
  return rows[0].id as string;
}

async function cargosDe(candidateId: string): Promise<string[]> {
  const rows = await q(
    `select position_id from candidate_positions where candidate_id = $1 order by position_id`,
    [candidateId],
  );
  return rows.map((r) => r.position_id as string);
}

let posA: TestPosition;
let posB: TestPosition;

beforeEach(async () => {
  await resetDatabase();
  posA = await createPosition({ slug: "cargo-a", vacancies: 1, votesPerVoter: 1 });
  posB = await createPosition({ slug: "cargo-b", vacancies: 1, votesPerVoter: 1 });
});

afterAll(async () => {
  await pool.end();
});

describe("B — cargos duplicados", () => {
  it("recusa [A,A] antes de qualquer escrita, preservando [A,B]", async () => {
    await createUnreleasedElection();
    const id = await salvar(null, { full_name: "Dupla", position_ids: [posA.id, posB.id] });
    expect(await cargosDe(id)).toHaveLength(2);

    await expect(
      salvar(id, { full_name: "Dupla", position_ids: [posA.id, posA.id] }),
    ).rejects.toThrow(/DUPLICATE_POSITIONS/);

    // O ponto do achado: o candidato NÃO pode ter ficado sem vínculos.
    expect(await cargosDe(id)).toEqual([posA.id, posB.id].sort());
  });

  it("[A,B] e [B,A] são a mesma composição", async () => {
    await createUnreleasedElection();
    const id = await salvar(null, { full_name: "Ordem", position_ids: [posA.id, posB.id] });

    // Mesmo conjunto em ordem trocada: aceito, e sem reescrever vínculo.
    await salvar(id, { full_name: "Ordem", position_ids: [posB.id, posA.id] });
    expect(await cargosDe(id)).toEqual([posA.id, posB.id].sort());
  });

  it("recusa lista vazia e mais de dois cargos", async () => {
    await createUnreleasedElection();
    await expect(salvar(null, { position_ids: [] })).rejects.toThrow(/INVALID_POSITIONS/);

    const posC = await createPosition({ slug: "cargo-c" });
    await expect(
      salvar(null, { position_ids: [posA.id, posB.id, posC.id] }),
    ).rejects.toThrow(/INVALID_POSITIONS/);
  });

  it("recusa cargo inexistente sem gravar candidato", async () => {
    await createUnreleasedElection();
    const antes = (await q(`select count(*)::int as n from candidates`))[0].n;
    await expect(salvar(null, { position_ids: [randomUUID()] })).rejects.toThrow(
      /INVALID_POSITIONS/,
    );
    expect((await q(`select count(*)::int as n from candidates`))[0].n).toBe(antes);
  });
});

describe("C — edição informativa não toca nos vínculos", () => {
  for (const campo of ["tagline", "presentation", "proposals", "video_url"] as const) {
    it(`alterar ${campo} preserva os vínculos sem DELETE/INSERT`, async () => {
      await createUnreleasedElection();
      const id = await salvar(null, { full_name: "Informativo", position_ids: [posA.id] });
      const [antes] = await q(
        `select xmin::text as versao from candidate_positions where candidate_id = $1`,
        [id],
      );

      const valor = campo === "video_url" ? "https://www.youtube.com/watch?v=aaaaaaaaaaa" : "texto";
      await salvar(id, { full_name: "Informativo", position_ids: [posA.id], [campo]: valor });

      const [depois] = await q(
        `select xmin::text as versao from candidate_positions where candidate_id = $1`,
        [id],
      );
      // xmin é a transação que criou a LINHA. Se ela mudou, a linha foi
      // apagada e recriada — exatamente o que abria a janela.
      expect(depois.versao).toBe(antes.versao);
      expect(await cargosDe(id)).toEqual([posA.id]);
    });
  }

  it("trocar a foto também não recria vínculo", async () => {
    await createUnreleasedElection();
    const id = await salvar(null, { full_name: "Foto", position_ids: [posA.id] });
    const [antes] = await q(
      `select xmin::text as versao from candidate_positions where candidate_id = $1`,
      [id],
    );

    await salvar(id, { full_name: "Foto", position_ids: [posA.id], photo_path: "fotos/nova.jpg" });

    const [depois] = await q(
      `select xmin::text as versao from candidate_positions where candidate_id = $1`,
      [id],
    );
    expect(depois.versao).toBe(antes.versao);
    const [cand] = await q(`select photo_path from candidates where id = $1`, [id]);
    expect(cand.photo_path).toBe("fotos/nova.jpg");
  });

  it("photo_path nulo mantém a foto atual em vez de apagá-la", async () => {
    await createUnreleasedElection();
    const id = await salvar(null, { full_name: "Foto", position_ids: [posA.id] });
    await salvar(id, { full_name: "Foto", position_ids: [posA.id], photo_path: "fotos/a.jpg" });
    await salvar(id, { full_name: "Foto", position_ids: [posA.id], presentation: "nova" });

    const [cand] = await q(`select photo_path, presentation from candidates where id = $1`, [id]);
    expect(cand.photo_path).toBe("fotos/a.jpg");
    expect(cand.presentation).toBe("nova");
  });

  it("a cédula nunca fica incompleta durante uma edição informativa", async () => {
    // Reprodução do achado: cargo com 2 candidatos para 1 vaga tem disputa.
    // Se a edição apagasse o vínculo de um deles, o cargo sairia da cédula
    // e `cast_ballot` aceitaria um voto sem ele.
    const electionId = await createTestElection();
    const a1 = await createCandidate("Disputa A1", [posA.id]);
    await createCandidate("Disputa A2", [posA.id]);
    const b1 = await createCandidate("Disputa B1", [posB.id]);
    await createCandidate("Disputa B2", [posB.id]);

    expect(await q(`select contested_position_ids() as ids`)).toEqual([
      { ids: expect.arrayContaining([posA.id, posB.id]) },
    ]);

    // Edição só de texto, concorrente com a votação.
    // display_order 0 é o que `createCandidate` grava (default da coluna):
    // reenviar qualquer outro valor seria mudança de composição, e a
    // eleição já está liberada.
    await salvar(a1, {
      full_name: "Disputa A1",
      position_ids: [posA.id],
      display_order: 0,
      presentation: "Apresentação nova",
    });

    const [ids] = await q(`select contested_position_ids() as ids`);
    expect(ids.ids).toEqual(expect.arrayContaining([posA.id, posB.id]));

    // Uma cédula com só um dos cargos continua sendo recusada.
    const nome = `Eleitor Incompleto ${Date.now()}`;
    const voter = await createVoter(nome);
    const sessao = await validateVoter(electionId, voter.registrationNumber, nome);
    await expect(
      castBallot(sessao.token!, {
        positions: [
          { position_id: posA.id, allocations: [{ candidate_id: a1, is_null_vote: false, quantity: 1 }] },
        ],
      }),
    ).rejects.toThrow(/INVALID_PAYLOAD/);

    // E a cédula completa continua sendo aceita.
    const nome2 = `Eleitor Completo ${Date.now()}`;
    const voter2 = await createVoter(nome2);
    const sessao2 = await validateVoter(electionId, voter2.registrationNumber, nome2);
    await expect(
      castBallot(sessao2.token!, {
        positions: [
          { position_id: posA.id, allocations: [{ candidate_id: a1, is_null_vote: false, quantity: 1 }] },
          { position_id: posB.id, allocations: [{ candidate_id: b1, is_null_vote: false, quantity: 1 }] },
        ],
      }),
    ).resolves.toBeTruthy();
  });
});

describe("congelamento depois da liberação", () => {
  it("recusa trocar nome, ordem, ativação e cargos", async () => {
    const id = await salvar(null, { full_name: "Congelado", position_ids: [posA.id] });
    await createTestElection(); // já liberada

    for (const mudanca of [
      { full_name: "Outro Nome" },
      { display_order: 9 },
      { active: false },
      { position_ids: [posB.id] },
      { position_ids: [posA.id, posB.id] },
    ]) {
      await expect(
        salvar(id, { full_name: "Congelado", position_ids: [posA.id], ...mudanca }),
      ).rejects.toThrow(/COMPOSITION_FROZEN/);
    }

    expect(await cargosDe(id)).toEqual([posA.id]);
  });

  it("aceita edição informativa com a composição intacta", async () => {
    const id = await salvar(null, { full_name: "Congelado", position_ids: [posA.id] });
    await createTestElection();

    await salvar(id, {
      full_name: "Congelado",
      position_ids: [posA.id],
      presentation: "Pode mudar",
      proposals: "Isto também",
    });

    const [cand] = await q(`select presentation, proposals from candidates where id = $1`, [id]);
    expect(cand).toMatchObject({ presentation: "Pode mudar", proposals: "Isto também" });
  });

  it("recusa cadastrar candidato novo", async () => {
    await createTestElection();
    await expect(
      salvar(null, { full_name: "Tardio", position_ids: [posA.id] }),
    ).rejects.toThrow(/COMPOSITION_FROZEN_CREATE/);
  });

  it("set_candidate_active recusa ativar e inativar", async () => {
    const id = await salvar(null, { full_name: "Ativo", position_ids: [posA.id] });
    await createTestElection();

    for (const ativo of [true, false]) {
      await expect(q(`select set_candidate_active($1, $2)`, [id, ativo])).rejects.toThrow(
        /COMPOSITION_FROZEN/,
      );
    }
    const [cand] = await q(`select active from candidates where id = $1`, [id]);
    expect(cand.active).toBe(true);
  });
});

describe("D — corrida entre editar a composição e liberar a votação", () => {
  /**
   * Duas conexões de verdade, com a ordem forçada pelo lock.
   *
   * A edição abre a transação e toma o lock da linha da eleição. A
   * liberação tenta tomar o mesmo lock e FICA BLOQUEADA até o commit da
   * edição. Não há caminho em que a edição termine depois da abertura.
   */
  async function editarComLockAberto(candidateId: string, novoNome: string, cargoIds: string[]) {
    const client = await pool.connect();
    await client.query("begin");
    await client.query(`select save_candidate($1,$2,null,null,null,null,true,1,$3,null)`, [
      candidateId,
      novoNome,
      cargoIds,
    ]);
    return {
      commit: async () => {
        await client.query("commit");
        client.release();
      },
      rollback: async () => {
        await client.query("rollback");
        client.release();
      },
    };
  }

  it("a liberação espera a edição em curso terminar", async () => {
    const id = await salvar(null, { full_name: "Corrida", position_ids: [posA.id] });
    const electionId = await createUnreleasedElection();

    const edicao = await editarComLockAberto(id, "Nome Trocado", [posB.id]);

    // A liberação fica pendurada no lock; só resolve depois do commit.
    let liberou = false;
    const liberacao = pool
      .query(`select release_voting($1) as t`, [electionId])
      .then((r) => {
        liberou = true;
        return r;
      });

    // Enquanto a edição não commita, a liberação não avança.
    await new Promise((r) => setTimeout(r, 300));
    expect(liberou).toBe(false);

    await edicao.commit();
    await liberacao;
    expect(liberou).toBe(true);

    // A edição valeu INTEIRA, antes da abertura.
    const [cand] = await q(`select full_name from candidates where id = $1`, [id]);
    expect(cand.full_name).toBe("Nome Trocado");
    expect(await cargosDe(id)).toEqual([posB.id]);
  });

  it("uma edição que chega depois da liberação é recusada", async () => {
    const id = await salvar(null, { full_name: "Tardia", position_ids: [posA.id] });
    const electionId = await createUnreleasedElection();

    await q(`select release_voting($1)`, [electionId]);

    await expect(salvar(id, { full_name: "Tarde Demais", position_ids: [posA.id] })).rejects.toThrow(
      /COMPOSITION_FROZEN/,
    );
    const [cand] = await q(`select full_name from candidates where id = $1`, [id]);
    expect(cand.full_name).toBe("Tardia");
  });

  it("liberação e edição em paralelo: nunca as duas vencem", async () => {
    // Dez rodadas: em cada uma, a edição e a liberação partem juntas. O
    // resultado tem que ser sempre um dos dois extremos — edição inteira
    // antes da abertura, ou edição recusada. Nunca composição alterada
    // depois de `voting_released_at`.
    for (let rodada = 0; rodada < 10; rodada += 1) {
      await resetDatabase();
      const pa = await createPosition({ slug: `r${rodada}-a` });
      const pb = await createPosition({ slug: `r${rodada}-b` });
      const id = await salvar(null, { full_name: "Paralela", position_ids: [pa.id] });
      const electionId = await createUnreleasedElection();

      const [edicao, liberacao] = await Promise.allSettled([
        pool.query(`select save_candidate($1,'Nome Novo',null,null,null,null,true,1,$2,null)`, [
          id,
          [pb.id],
        ]),
        pool.query(`select release_voting($1) as t`, [electionId]),
      ]);

      const [eleicao] = await q(`select voting_released_at from elections where id = $1`, [
        electionId,
      ]);
      const [cand] = await q(`select full_name from candidates where id = $1`, [id]);
      const cargos = await cargosDe(id);

      if (edicao.status === "fulfilled") {
        // Passou: então tem que ter passado por inteiro.
        expect({ rodada, nome: cand.full_name, cargos }).toEqual({
          rodada,
          nome: "Nome Novo",
          cargos: [pb.id],
        });
      } else {
        // Recusada: a composição está exatamente como estava.
        expect(String(edicao.reason)).toMatch(/COMPOSITION_FROZEN/);
        expect({ rodada, nome: cand.full_name, cargos }).toEqual({
          rodada,
          nome: "Paralela",
          cargos: [pa.id],
        });
      }

      // A liberação nunca falha por causa da corrida.
      expect({ rodada, status: liberacao.status }).toEqual({ rodada, status: "fulfilled" });
      expect(eleicao.voting_released_at).not.toBeNull();
    }
  }, 30_000);

  it("set_candidate_active também disputa o mesmo lock", async () => {
    const id = await salvar(null, { full_name: "Ativa", position_ids: [posA.id] });
    const electionId = await createUnreleasedElection();

    const client = await pool.connect();
    await client.query("begin");
    await client.query(`select set_candidate_active($1, false)`, [id]);

    let liberou = false;
    const liberacao = pool.query(`select release_voting($1)`, [electionId]).then((r) => {
      liberou = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(liberou).toBe(false);

    await client.query("commit");
    client.release();
    await liberacao;

    const [cand] = await q(`select active from candidates where id = $1`, [id]);
    expect(cand.active).toBe(false);
  });
});
