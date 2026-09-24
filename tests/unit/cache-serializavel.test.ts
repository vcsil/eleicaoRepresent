import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REGRESSÃO DO INCIDENTE: /resultados devolvendo 500 depois da publicação.
 *
 * `unstable_cache` grava o retorno no Data Cache e o reidrata como JSON.
 * Um `Map` sobrevive à PRIMEIRA requisição (cache MISS devolve o valor em
 * memória) e vira `{}` em todas as seguintes — sem `.get`, sem entradas.
 *
 * Em produção isso apareceu assim: a primeira visita a /resultados depois
 * da publicação funcionava, e a partir da segunda o Server Component
 * lançava `vacatedSeats.get is not a function` e a rota respondia 500.
 *
 * Os testes existentes não pegaram porque todos mockam `unstable_cache`
 * como identidade — o valor nunca passava por serialização. Aqui o mock
 * SIMULA o round-trip, que é a única forma de o teste enxergar o bug.
 */
const tabelas: Record<string, unknown[]> = {};
let eleicaoPublicada = true;

/** Mock fiel ao comportamento real: o que atravessa o cache vira JSON. */
const unstable_cache = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
  return async (...args: A): Promise<R> => {
    const resultado = await fn(...args);
    // É exatamente isto que o Data Cache faz com o valor guardado.
    return JSON.parse(JSON.stringify(resultado)) as R;
  };
};

vi.mock("next/cache", () => ({
  unstable_cache,
  updateTag: () => {},
  revalidatePath: () => {},
}));

function chain(tabela: string) {
  const stub: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order"]) stub[m] = () => stub;
  stub.maybeSingle = async () => ({
    data:
      tabela === "elections"
        ? { results_published_at: eleicaoPublicada ? "2026-09-24T00:00:00Z" : null }
        : null,
    error: null,
  });
  stub.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: tabelas[tabela] ?? [], error: null });
  return stub;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ from: (t: string) => chain(t) }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAnonClient: () => ({ from: (t: string) => chain(t) }),
}));

const { getVacatedSeatsByPosition, getPublishedResults, getRunoffRounds } = await import(
  "@/lib/election/results"
);

const ELEICAO = "11111111-1111-4111-8111-111111111111";
const CARGO = "aaaaaaaa-0000-4000-8000-000000000001";

beforeEach(() => {
  for (const k of Object.keys(tabelas)) delete tabelas[k];
  eleicaoPublicada = true;
});

describe("getVacatedSeatsByPosition sobrevive ao cache", () => {
  it("devolve um Map utilizável DEPOIS do round-trip de serialização", async () => {
    tabelas.seat_reassignments = [{ position_id: CARGO, promoted_candidate_id: null }];

    const vagas = await getVacatedSeatsByPosition(ELEICAO);

    // O incidente: aqui `vagas` era um objeto simples e `.get` não existia.
    expect(vagas).toBeInstanceOf(Map);
    expect(typeof vagas.get).toBe("function");
    expect(vagas.get(CARGO)).toBe(1);
  });

  it("chamadas repetidas continuam devolvendo Map (foi a 2a que quebrou)", async () => {
    tabelas.seat_reassignments = [{ position_id: CARGO, promoted_candidate_id: null }];

    for (let i = 1; i <= 3; i += 1) {
      const vagas = await getVacatedSeatsByPosition(ELEICAO);
      expect({ chamada: i, isMap: vagas instanceof Map, valor: vagas.get(CARGO) }).toEqual({
        chamada: i,
        isMap: true,
        valor: 1,
      });
    }
  });

  it("sem reassignments devolve Map vazio, não objeto", async () => {
    tabelas.seat_reassignments = [];
    const vagas = await getVacatedSeatsByPosition(ELEICAO);
    expect(vagas).toBeInstanceOf(Map);
    expect(vagas.size).toBe(0);
  });

  it("soma várias vagas do mesmo cargo", async () => {
    tabelas.seat_reassignments = [
      { position_id: CARGO, promoted_candidate_id: null },
      { position_id: CARGO, promoted_candidate_id: null },
      { position_id: CARGO, promoted_candidate_id: "promovido" },
    ];
    const vagas = await getVacatedSeatsByPosition(ELEICAO);
    expect(vagas.get(CARGO)).toBe(2);
  });

  it("ANTES da publicação não devolve nada — nem depois do cache", async () => {
    eleicaoPublicada = false;
    tabelas.seat_reassignments = [{ position_id: CARGO, promoted_candidate_id: null }];

    const vagas = await getVacatedSeatsByPosition(ELEICAO);
    expect(vagas).toBeInstanceOf(Map);
    expect(vagas.size).toBe(0);
  });
});

describe("as demais leituras cacheadas de /resultados sobrevivem ao cache", () => {
  it("getPublishedResults devolve array utilizável", async () => {
    tabelas.result_snapshots = [
      {
        position_id: CARGO,
        position_name: "Cargo",
        candidate_id: "c1",
        candidate_name: "Fulano",
        candidate_photo_path: null,
        votes_count: 3,
        rank: 1,
        elected: true,
        unopposed: false,
        seat_label: null,
      },
    ];
    const linhas = await getPublishedResults(ELEICAO);
    expect(Array.isArray(linhas)).toBe(true);
    expect(linhas[0]).toMatchObject({ candidate_name: "Fulano", votes_count: 3 });
  });

  it("getRunoffRounds devolve array utilizável, com rows dentro", async () => {
    tabelas.runoff_resolutions = [
      { position_id: CARGO, runoff_election_id: "r1", candidate_id: "c1" },
    ];
    tabelas.result_snapshots = [
      {
        election_id: "r1",
        position_id: CARGO,
        candidate_id: "c1",
        candidate_name: "Fulano",
        candidate_photo_path: null,
        votes_count: 5,
        rank: 1,
        elected: true,
        unopposed: false,
        seat_label: null,
      },
    ];
    const rodadas = await getRunoffRounds(ELEICAO);
    expect(rodadas).toHaveLength(1);
    expect(rodadas[0].winnerCandidateIds).toEqual(["c1"]);
    expect(rodadas[0].rows[0]).toMatchObject({ votes_count: 5 });
  });

  it("sem desempate nenhum, /resultados ainda funciona", async () => {
    tabelas.runoff_resolutions = [];
    expect(await getRunoffRounds(ELEICAO)).toEqual([]);
  });
});

describe("guarda: nada não-serializável pode atravessar o cache", () => {
  it("nenhuma função cacheada declara retorno com Map, Set ou Date", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raiz = new URL("../../lib", import.meta.url).pathname;

    function arquivos(dir: string, acc: string[] = []): string[] {
      for (const e of readdirSync(dir)) {
        const caminho = join(dir, e);
        if (statSync(caminho).isDirectory()) arquivos(caminho, acc);
        else if (e.endsWith(".ts")) acc.push(caminho);
      }
      return acc;
    }

    const suspeitos: { arquivo: string; funcao: string; retorno: string }[] = [];

    for (const arquivo of arquivos(raiz)) {
      const fonte = readFileSync(arquivo, "utf8");
      if (!fonte.includes("unstable_cache(")) continue;

      // Nomes das funções embrulhadas por unstable_cache.
      const embrulhadas = [...fonte.matchAll(/unstable_cache\(\s*(\w+)/g)].map((m) => m[1]);

      for (const nome of embrulhadas) {
        const decl = new RegExp(
          `function ${nome}\\s*\\([^)]*\\)\\s*:\\s*Promise<([^>]*(?:<[^>]*>)?[^>]*)>`,
        ).exec(fonte);
        if (!decl) continue;
        const retorno = decl[1];
        // O Data Cache reidrata como JSON: Map vira {}, Set vira {}, Date
        // vira string. Só estruturas simples atravessam intactas.
        if (/\b(Map|Set|Date)\b/.test(retorno)) {
          suspeitos.push({ arquivo: arquivo.split("/lib/")[1], funcao: nome, retorno });
        }
      }
    }

    expect(suspeitos).toEqual([]);
  });

  it("a guarda realmente enxerga um retorno Map (não passa por vazio)", () => {
    const fonteFalsa = `
      async function fetchAlgo(id: string): Promise<Map<string, number>> { return new Map(); }
      export const getAlgo = unstable_cache(fetchAlgo, ["algo"], {});
    `;
    const embrulhadas = [...fonteFalsa.matchAll(/unstable_cache\(\s*(\w+)/g)].map((m) => m[1]);
    expect(embrulhadas).toEqual(["fetchAlgo"]);

    const decl = new RegExp(
      `function ${embrulhadas[0]}\\s*\\([^)]*\\)\\s*:\\s*Promise<([^>]*(?:<[^>]*>)?[^>]*)>`,
    ).exec(fonteFalsa);
    expect(decl).not.toBeNull();
    expect(/\b(Map|Set|Date)\b/.test(decl![1])).toBe(true);
  });
});
