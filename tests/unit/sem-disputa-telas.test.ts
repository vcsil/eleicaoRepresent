import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "Eleito sem disputa" tem que se distinguir de "eleito com 0 votos".
 *
 * A diferença é `result_snapshots.unopposed` (migration 0020). Se a tela
 * caísse de volta na contagem, um cargo sem votação nenhuma apareceria
 * como "0 votos" — o que descreve uma derrota, não uma formalização.
 */

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const publico = read("app/(public)/resultados/page.tsx");
const interno = read("app/admin/(protected)/resultados/page.tsx");
const votar = read("app/(public)/votar/page.tsx");
const resultsLib = read("lib/election/results.ts");
const adminResultsLib = read("lib/admin/results.ts");

describe("as leituras de resultado trazem a marca do cargo sem disputa", () => {
  it("a leitura pública seleciona unopposed", () => {
    expect(resultsLib).toMatch(/elected, unopposed/);
  });

  it("a leitura interna seleciona unopposed", () => {
    expect(adminResultsLib).toMatch(/elected, unopposed/);
  });

  it("a leitura interna traz as vagas do cargo, para contar as não preenchidas", () => {
    expect(adminResultsLib).toContain("vacanciesByPosition");
  });
});

describe.each([
  ["resultado público", publico],
  ["resultado interno", interno],
])("%s", (_rotulo, fonte) => {
  it('exibe "Eleito sem disputa" quando a linha está marcada', () => {
    expect(fonte).toContain("Eleito sem disputa");
  });

  it("não exibe contagem de votos numa linha sem disputa", () => {
    expect(fonte).toMatch(/!row\.unopposed && \(/);
  });

  it("não exibe votos nulos num cargo sem disputa", () => {
    expect(fonte).toMatch(/semDisputa/);
  });

  it("mostra as vagas que ficaram sem preenchimento", () => {
    expect(fonte).toContain("vagasSemPreenchimento");
  });
});

describe("o resultado público não some com um cargo sem nenhuma candidatura", () => {
  it("registra as vagas vazias em vez de omitir a seção", () => {
    expect(publico).toContain("Nenhuma candidatura");
  });
});

describe("/votar sem nenhum cargo em disputa", () => {
  it("usa a mensagem combinada, sem urna e sem identificação", () => {
    expect(votar).toContain("Não há cargos em disputa nesta eleição");
    expect(votar).toContain(
      "Os candidatos sem concorrência serão formalmente definidos durante a apuração.",
    );
  });

  it("decide pela lista de cargos que o banco devolveu, não por contagem própria", () => {
    expect(votar).toContain('active.type === "general" && active.positions.length === 0');
  });

  it("a decisão vem antes de renderizar o formulário de identificação", () => {
    const aviso = votar.indexOf("Não há cargos em disputa");
    const formulario = votar.indexOf("<VoterValidationForm");
    expect(aviso).toBeGreaterThan(-1);
    expect(formulario).toBeGreaterThan(aviso);
  });
});
