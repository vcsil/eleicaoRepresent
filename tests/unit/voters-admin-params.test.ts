import { describe, expect, it } from "vitest";
import {
  parseVoterParams,
  buildVoterParams,
  nextSortDirection,
  DEFAULT_VOTER_PARAMS,
} from "@/lib/admin/voters-params";

describe("validação dos search params da lista de eleitores", () => {
  it("usa os defaults quando a URL está vazia", () => {
    expect(parseVoterParams({})).toEqual(DEFAULT_VOTER_PARAMS);
  });

  it("aceita uma combinação válida", () => {
    expect(parseVoterParams({ q: "maria", sort: "registration", dir: "desc", page: "3" })).toEqual({
      q: "maria",
      sort: "registration",
      dir: "desc",
      page: 3,
    });
  });

  it("devolve default para qualquer sort fora da lista", () => {
    for (const sort of ["", "full_name", "id", "sort", "'; drop table voters --", "registration_number"]) {
      expect(parseVoterParams({ sort }).sort, sort).toBe("name");
    }
  });

  it("devolve default para direção inválida", () => {
    for (const dir of ["ASC", "up", "1", ""]) {
      expect(parseVoterParams({ dir }).dir, dir).toBe("asc");
    }
  });

  it("corrige página inválida para 1", () => {
    for (const page of ["0", "-5", "abc", "1.5", "", "Infinity"]) {
      expect(parseVoterParams({ page }).page, page).toBe(1);
    }
  });

  it("usa apenas o primeiro valor quando o parâmetro vem repetido", () => {
    expect(parseVoterParams({ q: ["maria", "joao"] }).q).toBe("maria");
  });

  it("limita o tamanho do termo pesquisado", () => {
    expect(parseVoterParams({ q: "x".repeat(500) }).q).toBe("");
  });
});

describe("construção dos links da lista", () => {
  it("pesquisar volta para a página 1", () => {
    const params = buildVoterParams("q=ana&page=5&sort=name&dir=asc", { q: "maria" });
    expect(params.get("q")).toBe("maria");
    expect(params.get("page")).toBeNull();
    // Ordenação escolhida pelo administrador é preservada.
    expect(params.get("sort")).toBe("name");
  });

  it("reordenar volta para a página 1", () => {
    const params = buildVoterParams("q=ana&page=7", { sort: "registration", dir: "desc" });
    expect(params.get("page")).toBeNull();
    expect(params.get("sort")).toBe("registration");
    // Pesquisa ativa continua valendo.
    expect(params.get("q")).toBe("ana");
  });

  it("trocar de página preserva pesquisa e ordenação", () => {
    const params = buildVoterParams("q=ana&sort=status&dir=desc", { page: 4 });
    expect(params.get("page")).toBe("4");
    expect(params.get("q")).toBe("ana");
    expect(params.get("sort")).toBe("status");
    expect(params.get("dir")).toBe("desc");
  });

  it("página 1 não polui a URL", () => {
    expect(buildVoterParams("page=3", { page: 1 }).get("page")).toBeNull();
  });

  it("limpar a pesquisa remove o parâmetro", () => {
    const params = buildVoterParams("q=ana&page=2", { q: "   " });
    expect(params.get("q")).toBeNull();
    expect(params.get("page")).toBeNull();
  });
});

describe("direção do próximo clique no cabeçalho", () => {
  it("primeiro clique numa coluna nova é ascendente", () => {
    expect(nextSortDirection("registration", "name", "desc")).toBe("asc");
  });

  it("clique seguinte na mesma coluna inverte", () => {
    expect(nextSortDirection("name", "name", "asc")).toBe("desc");
    expect(nextSortDirection("name", "name", "desc")).toBe("asc");
  });
});
