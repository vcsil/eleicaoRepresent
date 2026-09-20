import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  pool,
  resetDatabase,
  createTestElection,
  releaseVoting,
  createPosition,
  createCandidate,
  type TestPosition,
} from "./db";

/**
 * CAMADA 1 — o congelamento vive no banco, não nas funções de gravação.
 *
 * `save_candidate` e `set_candidate_active` já recusavam alteração depois
 * da liberação, mas só quem passa POR ELAS. Um UPDATE direto — psql, SQL
 * Editor do painel, um script de manutenção — passava por fora, e
 * `positions` não tinha proteção alguma: mudar `vacancies` ou apagar
 * `seat_labels` no meio da votação reclassificaria o cargo e faria um
 * cargo votado virar "sem disputa".
 *
 * Todas as tentativas abaixo são SQL direto, sem passar por função nenhuma.
 */
async function q(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(sql, params);
  return rows as Record<string, unknown>[];
}

let electionId: string;
let pos: TestPosition;
let candidato: string;

beforeEach(async () => {
  await resetDatabase();
  electionId = await createTestElection();
  pos = await createPosition({ slug: "congelado", vacancies: 2, votesPerVoter: 2 });
  // Cargo ordenado de propósito: assim o teste de `seat_labels` exercita
  // uma mudança real nos dois sentidos (apagar e substituir).
  await q(`update positions set seat_labels = array['Primeiro', 'Segundo'] where id = $1`, [pos.id]);
  candidato = await createCandidate("Candidato Congelado", [pos.id]);
  await createCandidate("Segundo Congelado", [pos.id]);
  await releaseVoting(electionId);
});

afterAll(async () => {
  await pool.end();
});

describe("candidates", () => {
  it("INSERT é bloqueado", async () => {
    await expect(
      q(`insert into candidates (full_name, active) values ('Tardio', true)`),
    ).rejects.toThrow(/COMPOSITION_FROZEN/);
    const [n] = await q(`select count(*)::int as n from candidates`);
    expect(n.n).toBe(2);
  });

  it("DELETE é bloqueado", async () => {
    await expect(q(`delete from candidates where id = $1`, [candidato])).rejects.toThrow(
      /COMPOSITION_FROZEN/,
    );
    expect(await q(`select 1 from candidates where id = $1`, [candidato])).toHaveLength(1);
  });

  for (const [campo, valor] of [
    ["active", false],
    ["full_name", "Nome Trocado"],
    ["display_order", 99],
  ] as const) {
    it(`UPDATE de ${campo} é bloqueado`, async () => {
      await expect(
        q(`update candidates set ${campo} = $2 where id = $1`, [candidato, valor]),
      ).rejects.toThrow(/COMPOSITION_FROZEN/);
    });
  }

  for (const campo of ["photo_path", "tagline", "presentation", "proposals"] as const) {
    it(`UPDATE de ${campo} continua permitido`, async () => {
      await q(`update candidates set ${campo} = 'novo valor' where id = $1`, [candidato]);
      const [row] = await q(`select ${campo} as v from candidates where id = $1`, [candidato]);
      expect(row.v).toBe("novo valor");
    });
  }

  it("UPDATE de video_url continua permitido", async () => {
    const url = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
    await q(`update candidates set video_url = $2 where id = $1`, [candidato, url]);
    const [row] = await q(`select video_url from candidates where id = $1`, [candidato]);
    expect(row.video_url).toBe(url);
  });

  it("um UPDATE que mistura informativo e estrutural é bloqueado inteiro", async () => {
    await expect(
      q(`update candidates set tagline = 'ok', full_name = 'Nome Novo' where id = $1`, [candidato]),
    ).rejects.toThrow(/COMPOSITION_FROZEN/);
    const [row] = await q(`select tagline, full_name from candidates where id = $1`, [candidato]);
    expect(row).toEqual({ tagline: null, full_name: "Candidato Congelado" });
  });

  it("reescrever o MESMO valor estrutural não é bloqueado", async () => {
    // A comparação é por valor (`is distinct from`), não por coluna tocada:
    // `save_candidate` reenvia todos os campos em toda gravação.
    await q(
      `update candidates set full_name = 'Candidato Congelado', active = true,
              display_order = 0, presentation = 'nova' where id = $1`,
      [candidato],
    );
    const [row] = await q(`select presentation from candidates where id = $1`, [candidato]);
    expect(row.presentation).toBe("nova");
  });
});

describe("candidate_positions", () => {
  it("INSERT é bloqueado", async () => {
    const outro = await q(
      `insert into positions (slug, name, vacancies, votes_per_voter, display_order, active)
       values ('nao-entra', 'X', 1, 1, 9, true) returning id`,
    ).catch((e) => e);
    // A própria criação do cargo já é recusada.
    expect(String(outro)).toMatch(/COMPOSITION_FROZEN/);

    await expect(
      q(`insert into candidate_positions (candidate_id, position_id) values ($1, $2)`, [
        candidato,
        randomUUID(),
      ]),
    ).rejects.toThrow(/COMPOSITION_FROZEN/);
  });

  it("DELETE é bloqueado", async () => {
    await expect(
      q(`delete from candidate_positions where candidate_id = $1`, [candidato]),
    ).rejects.toThrow(/COMPOSITION_FROZEN/);
    expect(
      await q(`select 1 from candidate_positions where candidate_id = $1`, [candidato]),
    ).toHaveLength(1);
  });

  it("UPDATE é bloqueado", async () => {
    await expect(
      q(`update candidate_positions set position_id = $2 where candidate_id = $1`, [
        candidato,
        pos.id,
      ]),
    ).rejects.toThrow(/COMPOSITION_FROZEN/);
  });
});

describe("positions", () => {
  for (const [campo, valor] of [
    ["vacancies", 5],
    ["votes_per_voter", 5],
    ["active", false],
    ["display_order", 42],
    ["slug", "outro-slug"],
  ] as const) {
    it(`UPDATE de ${campo} é bloqueado`, async () => {
      await expect(
        q(`update positions set ${campo} = $2 where id = $1`, [pos.id, valor]),
      ).rejects.toThrow(/COMPOSITION_FROZEN/);
    });
  }

  it("UPDATE de seat_labels é bloqueado", async () => {
    // O pior caso: apagar seat_labels reclassificaria o cargo e um cargo
    // votado viraria "sem disputa" no meio da apuração.
    await expect(
      q(`update positions set seat_labels = null where id = $1`, [pos.id]),
    ).rejects.toThrow(/COMPOSITION_FROZEN/);

    await expect(
      q(`update positions set seat_labels = array['A','B'] where id = $1`, [pos.id]),
    ).rejects.toThrow(/COMPOSITION_FROZEN/);
  });

  it("INSERT e DELETE são bloqueados", async () => {
    await expect(
      q(`insert into positions (slug, name, vacancies, votes_per_voter, display_order, active)
         values ('novo', 'Novo', 1, 1, 9, true)`),
    ).rejects.toThrow(/COMPOSITION_FROZEN/);

    await expect(q(`delete from positions where id = $1`, [pos.id])).rejects.toThrow(
      /COMPOSITION_FROZEN/,
    );
  });

  for (const campo of ["name", "description", "responsibilities", "profile"] as const) {
    it(`UPDATE de ${campo} continua permitido`, async () => {
      await q(`update positions set ${campo} = 'texto novo' where id = $1`, [pos.id]);
      const [row] = await q(`select ${campo} as v from positions where id = $1`, [pos.id]);
      expect(row.v).toBe("texto novo");
    });
  }
});

describe("antes da liberação nada disso é bloqueado", () => {
  it("cadastrar, inativar e mudar vagas funcionam enquanto a votação não abre", async () => {
    await resetDatabase();
    await createTestElection(); // sem liberar
    const p = await createPosition({ slug: "livre", vacancies: 1, votesPerVoter: 1 });
    const c = await createCandidate("Livre", [p.id]);

    await q(`update candidates set active = false, full_name = 'Outro' where id = $1`, [c]);
    await q(`update positions set vacancies = 3, seat_labels = array['A','B','C'] where id = $1`, [
      p.id,
    ]);
    await q(`delete from candidate_positions where candidate_id = $1`, [c]);
    await q(`delete from candidates where id = $1`, [c]);

    expect(await q(`select 1 from candidates where id = $1`, [c])).toHaveLength(0);
  });
});

describe("a guarda de última instância continua de pé", () => {
  it("UNCONTESTED_POSITION_HAS_VOTES ainda dispara com voto inconsistente", async () => {
    await resetDatabase();
    const id = await createTestElection();
    const p = await createPosition({ slug: "inconsistente", vacancies: 2, votesPerVoter: 2 });
    const c = await createCandidate("Inc A", [p.id]);
    await createCandidate("Inc B", [p.id]);
    await releaseVoting(id);

    // Cargo sem seat_labels, 2 candidatos para 2 vagas: não vai à urna.
    expect((await q(`select position_requires_voting($1) as r`, [p.id]))[0].r).toBe(false);

    // Voto gravado direto, simulando inconsistência que nenhuma invariante
    // deveria permitir (dado anterior à regra, ou trigger desabilitada).
    const voter = await q(
      `insert into voters (registration_number, full_name, active)
       values ('inc-1', 'Eleitor Inc', true) returning id`,
    );
    const [ballot] = await q(
      `insert into ballots (election_id, submitted_at) values ($1, now()) returning id`,
      [id],
    );
    await q(
      `insert into ballot_choices (ballot_id, position_id, candidate_id, is_null_vote, vote_slot)
       values ($1,$2,$3,false,1),($1,$2,$3,false,2)`,
      [ballot.id, p.id, c],
    );
    await q(`insert into audit_vote_links (election_id, voter_id, ballot_id) values ($1,$2,$3)`, [
      id,
      voter[0].id,
      ballot.id,
    ]);

    await q(`update elections set voting_closed_manually_at = now() where id = $1`, [id]);
    await expect(q(`select compute_results($1)`, [id])).rejects.toThrow(
      /UNCONTESTED_POSITION_HAS_VOTES/,
    );

    // Nenhum voto apagado ou zerado.
    expect(
      (await q(`select count(*)::int as n from ballot_choices where position_id = $1`, [p.id]))[0].n,
    ).toBe(2);
    expect(await q(`select 1 from result_snapshots where election_id = $1`, [id])).toHaveLength(0);
  });
});
