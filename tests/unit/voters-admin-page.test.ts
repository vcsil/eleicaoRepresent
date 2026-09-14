import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fake do supabase-js que REALMENTE filtra, ordena e pagina em memória, e
 * registra as chamadas. Assim os testes afirmam duas coisas distintas:
 *
 *  - o resultado (página 2 traz os registros 21-40, ordenados certo);
 *  - o CONTRATO com o banco — que houve `range`, e não uma leitura inteira
 *    seguida de slice. É esse contrato que impede a tela de voltar a
 *    carregar a base toda quando ela crescer.
 */

/**
 * Divide a expressão do PostgREST em cláusulas de topo, ignorando vírgulas
 * DENTRO de aspas — que é justamente o comportamento do qual a defesa
 * depende. Um divisor ingênuo não conseguiria distinguir os dois casos.
 */
function clausulasDeTopo(filtro: string): string[] {
  const partes: string[] = [];
  let atual = "";
  let dentroDeAspas = false;
  for (let i = 0; i < filtro.length; i += 1) {
    const c = filtro[i];
    if (c === "\\") {
      atual += c + (filtro[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (c === '"') dentroDeAspas = !dentroDeAspas;
    if (c === "," && !dentroDeAspas) {
      partes.push(atual);
      atual = "";
      continue;
    }
    atual += c;
  }
  partes.push(atual);
  return partes;
}

type Row = { id: string; registration_number: string; full_name: string; normalized_name: string; active: boolean };

let tabela: Row[] = [];
const chamadas: { range?: [number, number]; or?: string; head: boolean; orders: string[] }[] = [];

function query(rows: Row[], head: boolean) {
  const registro = { head, orders: [] as string[] } as (typeof chamadas)[number];
  chamadas.push(registro);
  let atual = [...rows];
  const ordens: { campo: keyof Row; asc: boolean }[] = [];

  const api = {
    or(filtro: string) {
      registro.or = filtro;
      const partes = clausulasDeTopo(filtro);
      const casa = (r: Row) =>
        partes.some((parte) => {
          const m = /^([a-z_]+)\.ilike\.(.*)$/.exec(parte);
          if (!m) return false;
          const campo = m[1] as keyof Row;
          const valor = m[2].replace(/^"|"$/g, "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
          const alvo = String(r[campo] ?? "").toLowerCase();
          return alvo.includes(valor.replace(/%/g, "").toLowerCase());
        });
      atual = atual.filter(casa);
      return api;
    },
    eq(campo: keyof Row, valor: unknown) {
      atual = atual.filter((r) => r[campo] === valor);
      return api;
    },
    order(campo: keyof Row, opts?: { ascending?: boolean }) {
      const asc = opts?.ascending !== false;
      registro.orders.push(`${campo}:${asc ? "asc" : "desc"}`);
      ordens.push({ campo, asc });
      // Ordena por TODAS as chaves acumuladas, na ordem em que foram
      // pedidas: no PostgREST a primeira é a primária, não a última.
      atual = [...atual].sort((a, b) => {
        for (const { campo: c, asc: dir } of ordens) {
          const va = a[c];
          const vb = b[c];
          if (va === vb) continue;
          return (va < vb ? -1 : 1) * (dir ? 1 : -1);
        }
        return 0;
      });
      return api;
    },
    range(from: number, to: number) {
      registro.range = [from, to];
      atual = atual.slice(from, to + 1);
      return api;
    },
    then(resolve: (v: unknown) => unknown) {
      return resolve({ data: head ? null : atual, count: head ? atual.length : atual.length, error: null });
    },
  };
  return api;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: (_cols: string, opts?: { count?: string; head?: boolean }) =>
        query(tabela, Boolean(opts?.head)),
    }),
  }),
}));

const { getVotersPage, VOTERS_PAGE_SIZE } = await import("@/lib/admin/voters");

function normalizar(nome: string) {
  return nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function eleitor(n: number, nome: string, active = true): Row {
  return {
    id: `id-${String(n).padStart(4, "0")}`,
    registration_number: String(20260000 + n),
    full_name: nome,
    normalized_name: normalizar(nome),
    active,
  };
}

beforeEach(() => {
  chamadas.length = 0;
  // 87 eleitores: o exemplo da especificação (87 -> 5 páginas de 20).
  tabela = Array.from({ length: 87 }, (_, i) =>
    eleitor(i + 1, `Eleitor ${String(i + 1).padStart(3, "0")}`, i % 29 !== 0),
  );
});

describe("paginação no banco", () => {
  it("devolve no máximo 20 eleitores", async () => {
    const r = await getVotersPage();
    expect(VOTERS_PAGE_SIZE).toBe(20);
    expect(r.voters).toHaveLength(20);
  });

  it("pede o intervalo ao banco em vez de carregar a base inteira", async () => {
    await getVotersPage({ page: 1 });
    const paginada = chamadas.find((c) => !c.head && c.range);
    expect(paginada?.range).toEqual([0, 19]);
  });

  it("página 2 pede o intervalo seguinte e traz os registros seguintes", async () => {
    const p1 = await getVotersPage({ page: 1 });
    chamadas.length = 0;
    const p2 = await getVotersPage({ page: 2 });
    expect(chamadas.find((c) => !c.head && c.range)?.range).toEqual([20, 39]);
    expect(p2.voters[0].full_name).toBe("Eleitor 021");
    // Nenhum registro repetido entre páginas.
    const ids = new Set([...p1.voters, ...p2.voters].map((v) => v.id));
    expect(ids.size).toBe(40);
  });

  it("calcula total e número de páginas", async () => {
    const r = await getVotersPage();
    expect(r.total).toBe(87);
    expect(r.pageCount).toBe(5);
    expect(r.filteredTotal).toBe(87);
  });

  it("conta os ativos sobre a BASE, não sobre a página", async () => {
    const ativosReais = tabela.filter((v) => v.active).length;
    const r = await getVotersPage({ page: 3 });
    expect(r.activeTotal).toBe(ativosReais);
    expect(r.total).toBe(87);
  });

  it("página além do fim volta para a última válida", async () => {
    const r = await getVotersPage({ page: 99 });
    expect(r.page).toBe(5);
    expect(r.voters.length).toBeGreaterThan(0);
  });

  it("base vazia não gera página inválida", async () => {
    tabela = [];
    const r = await getVotersPage({ page: 4 });
    expect(r.page).toBe(1);
    expect(r.pageCount).toBe(1);
    expect(r.voters).toEqual([]);
  });
});

describe("pesquisa", () => {
  beforeEach(() => {
    tabela = [
      eleitor(1, "Maria Fernanda"),
      eleitor(2, "João da Silva"),
      eleitor(3, "MARIA JOSÉ"),
      eleitor(4, "Bruno Tavares", false),
    ];
    tabela[1].registration_number = "00123400";
  });

  it("encontra pela matrícula exata", async () => {
    const r = await getVotersPage({ query: "20260001" });
    expect(r.voters.map((v) => v.full_name)).toEqual(["Maria Fernanda"]);
  });

  it("encontra por trecho da matrícula, preservando zeros à esquerda", async () => {
    const r = await getVotersPage({ query: "001234" });
    expect(r.voters.map((v) => v.full_name)).toEqual(["João da Silva"]);
  });

  it("encontra por trecho do nome", async () => {
    const r = await getVotersPage({ query: "Fernanda" });
    expect(r.voters.map((v) => v.full_name)).toEqual(["Maria Fernanda"]);
  });

  it("ignora maiúsculas e minúsculas", async () => {
    const r = await getVotersPage({ query: "maria" });
    expect(r.voters).toHaveLength(2);
  });

  it("ignora acentos: 'joao' encontra 'João'", async () => {
    const r = await getVotersPage({ query: "joao" });
    expect(r.voters.map((v) => v.full_name)).toEqual(["João da Silva"]);
  });

  it("ignora acentos também no sentido inverso: 'JOSÉ' encontra o registro", async () => {
    const r = await getVotersPage({ query: "josé" });
    expect(r.voters.map((v) => v.full_name)).toEqual(["MARIA JOSÉ"]);
  });

  it("inclui eleitores inativos na pesquisa", async () => {
    const r = await getVotersPage({ query: "Bruno" });
    expect(r.voters.map((v) => v.active)).toEqual([false]);
  });

  it("pesquisa sem resultado devolve lista vazia e página válida", async () => {
    const r = await getVotersPage({ query: "zzzz", page: 3 });
    expect(r.voters).toEqual([]);
    expect(r.filteredTotal).toBe(0);
    expect(r.page).toBe(1);
    expect(r.pageCount).toBe(1);
    // O resumo da base continua correto, mesmo com filtro sem resultado.
    expect(r.total).toBe(4);
  });

  it("não deixa o termo alterar a estrutura do filtro", async () => {
    // Vírgula e parênteses são estruturais na expressão do PostgREST.
    await getVotersPage({ query: 'a,b.eq.c)' });
    const filtro = chamadas.find((c) => c.or)?.or ?? "";
    // O termo inteiro vai aspeado, como VALOR, nos dois campos.
    expect(filtro).toContain('registration_number.ilike."%a,b.eq.c)%"');
    const clausulas = clausulasDeTopo(filtro);
    expect(clausulas).toHaveLength(2);
    expect(clausulas.every((c) => /^[a-z_]+\.ilike\./.test(c))).toBe(true);
  });

  it("escapa aspas dentro do termo", async () => {
    await getVotersPage({ query: 'a"b' });
    expect(chamadas.find((c) => c.or)?.or).toContain('\\"');
  });
});

describe("ordenação", () => {
  beforeEach(() => {
    tabela = [
      eleitor(3, "Carlos", true),
      eleitor(1, "Ana", false),
      eleitor(2, "Bruno", true),
    ];
  });

  it("matrícula ascendente", async () => {
    const r = await getVotersPage({ sort: "registration", direction: "asc" });
    expect(r.voters.map((v) => v.registration_number)).toEqual(["20260001", "20260002", "20260003"]);
  });

  it("matrícula descendente", async () => {
    const r = await getVotersPage({ sort: "registration", direction: "desc" });
    expect(r.voters.map((v) => v.registration_number)).toEqual(["20260003", "20260002", "20260001"]);
  });

  it("ordena matrícula como texto, sem converter para número", async () => {
    const ordem = chamadas.length;
    await getVotersPage({ sort: "registration", direction: "asc" });
    expect(chamadas.slice(ordem).some((c) => c.orders.includes("registration_number:asc"))).toBe(true);
  });

  it("nome ascendente e descendente", async () => {
    expect((await getVotersPage({ sort: "name", direction: "asc" })).voters.map((v) => v.full_name))
      .toEqual(["Ana", "Bruno", "Carlos"]);
    expect((await getVotersPage({ sort: "name", direction: "desc" })).voters.map((v) => v.full_name))
      .toEqual(["Carlos", "Bruno", "Ana"]);
  });

  it("situação ascendente coloca os ATIVOS primeiro", async () => {
    const r = await getVotersPage({ sort: "status", direction: "asc" });
    expect(r.voters.map((v) => v.active)).toEqual([true, true, false]);
  });

  it("situação descendente coloca os INATIVOS primeiro", async () => {
    const r = await getVotersPage({ sort: "status", direction: "desc" });
    expect(r.voters[0].active).toBe(false);
  });

  it("empate de situação é desempatado por nome, de forma estável", async () => {
    const r = await getVotersPage({ sort: "status", direction: "asc" });
    // Entre os dois ativos, ordem alfabética.
    expect(r.voters.slice(0, 2).map((v) => v.full_name)).toEqual(["Bruno", "Carlos"]);
  });

  it("nome é o default", async () => {
    expect((await getVotersPage()).voters.map((v) => v.full_name)).toEqual(["Ana", "Bruno", "Carlos"]);
  });
});

describe("pesquisa + ordenação + paginação combinam na ordem certa", () => {
  it("filtra, depois ordena, depois pagina", async () => {
    tabela = Array.from({ length: 50 }, (_, i) =>
      eleitor(i + 1, i % 2 === 0 ? `Maria ${String(i).padStart(2, "0")}` : `Outro ${i}`),
    );

    const r = await getVotersPage({ query: "maria", sort: "name", direction: "desc", page: 2 });

    // 25 "Maria" -> 2 páginas; a segunda tem 5.
    expect(r.filteredTotal).toBe(25);
    expect(r.pageCount).toBe(2);
    expect(r.voters).toHaveLength(5);
    // Todos são Maria (filtrou antes de paginar) e a ordem é decrescente.
    expect(r.voters.every((v) => v.full_name.startsWith("Maria"))).toBe(true);
    expect(r.voters.map((v) => v.full_name)).toEqual([...r.voters.map((v) => v.full_name)].sort().reverse());
    // E o resumo da base não foi contaminado pelo filtro.
    expect(r.total).toBe(50);
  });
});
