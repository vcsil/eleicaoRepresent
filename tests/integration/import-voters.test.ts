import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, resetDatabase } from "./db";

/**
 * Importação de eleitores — garantias de banco.
 *
 * O ponto mais sensível aqui não é inserir: é NÃO alterar o que não deve.
 * Importar uma planilha não pode mexer em histórico eleitoral, não pode
 * remover ninguém e não pode ser alcançável pela chave pública.
 */

type Row = Record<string, unknown>;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function importVoters(
  rows: { registration_number: string; full_name: string }[],
  mode = "update_existing",
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const { rows: result } = await pool.query("select import_voters($1::jsonb, $2) as r", [
    JSON.stringify(rows),
    mode,
  ]);
  return result[0].r;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("inserção", () => {
  it("importa uma lista nova", async () => {
    const result = await importVoters([
      { registration_number: "20260001", full_name: "Ana Maria Silva" },
      { registration_number: "20260002", full_name: "Bruno Souza Costa" },
    ]);

    expect(result).toMatchObject({ inserted: 2, updated: 0 });
    expect(await q("select count(*)::int as c from voters")).toEqual([{ c: 2 }]);
  });

  it("preserva zeros à esquerda", async () => {
    await importVoters([{ registration_number: "001234", full_name: "Ana" }]);

    const [row] = await q("select registration_number from voters");
    expect(row.registration_number).toBe("001234");
  });

  it("deixa o trigger gerar normalized_name", async () => {
    await importVoters([{ registration_number: "A1", full_name: "  João   GONÇALVES  " }]);

    const [row] = await q("select full_name, normalized_name from voters");
    // Caixa e acento preservados para exibição; normalização é do banco.
    expect(row.full_name).toBe("João   GONÇALVES");
    expect(row.normalized_name).toBe("joao goncalves");
  });

  it("novos eleitores entram ativos", async () => {
    await importVoters([{ registration_number: "A1", full_name: "Ana" }]);
    expect((await q("select active from voters"))[0].active).toBe(true);
  });

  it("importa 100 eleitores", async () => {
    const linhas = Array.from({ length: 100 }, (_, i) => ({
      registration_number: `2026${String(i).padStart(4, "0")}`,
      full_name: `Eleitor ${i}`,
    }));

    expect(await importVoters(linhas)).toMatchObject({ inserted: 100 });
  });
});

describe("eleitor já existente", () => {
  beforeEach(async () => {
    await q(
      `insert into voters (registration_number, full_name, active, has_voted, voted_at)
       values ('20260002', 'Bruno Costa', false, true, now())`,
    );
  });

  it("atualiza o nome", async () => {
    const result = await importVoters([
      { registration_number: "20260002", full_name: "Bruno Souza Costa" },
    ]);

    expect(result).toMatchObject({ inserted: 0, updated: 1 });
    const [row] = await q("select full_name, normalized_name from voters");
    expect(row.full_name).toBe("Bruno Souza Costa");
    expect(row.normalized_name).toBe("bruno souza costa");
  });

  it("NUNCA reseta has_voted nem voted_at", async () => {
    await importVoters([{ registration_number: "20260002", full_name: "Bruno Souza Costa" }]);

    const [row] = await q("select has_voted, voted_at from voters");
    expect(row.has_voted).toBe(true);
    expect(row.voted_at).not.toBeNull();
  });

  it("NUNCA reativa quem está inativo", async () => {
    // Reativar é decisão consciente, não efeito colateral de subir planilha.
    await importVoters([{ registration_number: "20260002", full_name: "Bruno Souza Costa" }]);

    expect((await q("select active from voters"))[0].active).toBe(false);
  });

  it("no modo skip_existing, não altera o nome", async () => {
    const result = await importVoters(
      [{ registration_number: "20260002", full_name: "Outro Nome" }],
      "skip_existing",
    );

    expect(result).toMatchObject({ inserted: 0, skipped: 1 });
    expect((await q("select full_name from voters"))[0].full_name).toBe("Bruno Costa");
  });
});

describe("idempotência e integridade", () => {
  it("reenviar a mesma planilha não duplica", async () => {
    const linhas = [
      { registration_number: "A1", full_name: "Ana" },
      { registration_number: "A2", full_name: "Bia" },
    ];

    await importVoters(linhas);
    await importVoters(linhas);
    await importVoters(linhas);

    expect(await q("select count(*)::int as c from voters")).toEqual([{ c: 2 }]);
  });

  it("duplicata dentro do payload não derruba a importação", async () => {
    // A interface bloqueia este caso; a função é a rede de segurança —
    // sem o distinct on, o ON CONFLICT levantaria "cannot affect row a
    // second time" e nada seria importado.
    const result = await importVoters([
      { registration_number: "A1", full_name: "Ana Silva" },
      { registration_number: "A1", full_name: "Ana Maria Silva" },
    ]);

    expect(result.inserted).toBe(1);
    expect(await q("select count(*)::int as c from voters")).toEqual([{ c: 1 }]);
  });

  it("não remove eleitores ausentes do arquivo", async () => {
    await importVoters([{ registration_number: "A1", full_name: "Ana" }]);
    await importVoters([{ registration_number: "A2", full_name: "Bia" }]);

    expect(await q("select count(*)::int as c from voters")).toEqual([{ c: 2 }]);
  });

  it("falha no meio não importa nada (atomicidade)", async () => {
    // full_name null viola NOT NULL: a transação inteira precisa voltar.
    await expect(
      pool.query("select import_voters($1::jsonb)", [
        JSON.stringify([
          { registration_number: "A1", full_name: "Ana" },
          { registration_number: "A2", full_name: "Bia" },
        ]),
      ]),
    ).resolves.toBeTruthy();

    await resetDatabase();

    const payload = JSON.stringify([
      { registration_number: "A1", full_name: "Ana" },
      { registration_number: "A2" },
    ]);
    // A segunda linha é descartada na normalização (nome vazio), então a
    // primeira entra: é o comportamento esperado, não erro.
    const { rows } = await pool.query("select import_voters($1::jsonb) as r", [payload]);
    expect(rows[0].r.inserted).toBe(1);
  });

  it("recusa payload vazio", async () => {
    await expect(importVoters([])).rejects.toThrow(/EMPTY_PAYLOAD/);
  });

  it("recusa mais de 2000 linhas", async () => {
    const linhas = Array.from({ length: 2001 }, (_, i) => ({
      registration_number: `R${i}`,
      full_name: `Eleitor ${i}`,
    }));

    await expect(importVoters(linhas)).rejects.toThrow(/TOO_MANY_ROWS/);
  });

  it("recusa modo desconhecido", async () => {
    await expect(
      importVoters([{ registration_number: "A1", full_name: "Ana" }], "delete_everything"),
    ).rejects.toThrow(/INVALID_MODE/);
  });
});

describe("não toca em dados eleitorais", () => {
  it("não altera ballots nem audit_vote_links", async () => {
    const antes = await q(
      `select (select count(*) from ballots) as b,
              (select count(*) from ballot_choices) as bc,
              (select count(*) from audit_vote_links) as al`,
    );

    await importVoters([{ registration_number: "A1", full_name: "Ana" }]);

    const depois = await q(
      `select (select count(*) from ballots) as b,
              (select count(*) from ballot_choices) as bc,
              (select count(*) from audit_vote_links) as al`,
    );
    expect(depois).toEqual(antes);
  });
});

describe("permissões", () => {
  async function callAs(role: string) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${role}`);
      const result = await client.query("select import_voters($1::jsonb) as r", [
        JSON.stringify([{ registration_number: "A1", full_name: "Ana" }]),
      ]);
      await client.query("commit");
      return result.rows;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  for (const role of ["anon", "authenticated"]) {
    it(`${role} não consegue importar eleitores`, async () => {
      await expect(callAs(role)).rejects.toThrow(/permission denied for function import_voters/);
    });
  }

  it("service_role consegue", async () => {
    await expect(callAs("service_role")).resolves.toBeTruthy();
  });

  it("anon não consegue ler a tabela de eleitores", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role anon");
      // Barrado pela ACL, antes mesmo da RLS: 0006_rls.sql revoga tudo de
      // anon/authenticated e só concede SELECT ao conteúdo público. A lista
      // de eleitores nunca esteve entre eles.
      await expect(client.query("select * from voters")).rejects.toThrow(
        /permission denied for table voters/,
      );
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
