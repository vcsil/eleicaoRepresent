import { z } from "zod";
import { VOTER_SORTS, type VoterSort, type SortDirection } from "@/lib/admin/voters-values";

export type VoterListParams = {
  q: string;
  sort: VoterSort;
  dir: SortDirection;
  page: number;
};

export const DEFAULT_VOTER_PARAMS: VoterListParams = {
  q: "",
  sort: "name",
  dir: "asc",
  page: 1,
};

/**
 * Nada vindo da URL chega à consulta sem passar por aqui.
 *
 * `.catch()` em cada campo faz valor inválido cair no default em vez de
 * lançar: `?sort=; DROP` ou `?page=-3` viram apenas a listagem padrão.
 */
const schema = z.object({
  q: z.string().trim().max(120).catch(""),
  sort: z.enum(VOTER_SORTS).catch(DEFAULT_VOTER_PARAMS.sort),
  dir: z.enum(["asc", "desc"]).catch(DEFAULT_VOTER_PARAMS.dir),
  page: z.coerce.number().int().min(1).catch(1),
});

export function parseVoterParams(
  raw: Record<string, string | string[] | undefined>,
): VoterListParams {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return schema.parse({
    q: first(raw.q) ?? "",
    sort: first(raw.sort) ?? DEFAULT_VOTER_PARAMS.sort,
    dir: first(raw.dir) ?? DEFAULT_VOTER_PARAMS.dir,
    page: first(raw.page) ?? 1,
  });
}

/**
 * Reescreve os search params preservando o que não mudou.
 *
 * Mudar pesquisa ou ordenação SEMPRE volta para a página 1 — manter
 * `page=5` ao pesquisar mostraria uma lista vazia para um filtro com poucos
 * resultados. Só a própria navegação de página preserva o número.
 */
export function buildVoterParams(
  current: URLSearchParams | string,
  changes: Partial<VoterListParams>,
): URLSearchParams {
  const params = new URLSearchParams(current.toString());

  if ("q" in changes) {
    const q = (changes.q ?? "").trim();
    if (q) params.set("q", q);
    else params.delete("q");
  }
  if (changes.sort) params.set("sort", changes.sort);
  if (changes.dir) params.set("dir", changes.dir);

  const mudouFiltro = "q" in changes || changes.sort !== undefined || changes.dir !== undefined;
  if (mudouFiltro) {
    params.delete("page");
  } else if (changes.page !== undefined) {
    if (changes.page <= 1) params.delete("page");
    else params.set("page", String(changes.page));
  }

  return params;
}

/** Próxima direção ao clicar num cabeçalho: 1º clique asc, depois inverte. */
export function nextSortDirection(
  column: VoterSort,
  currentSort: VoterSort,
  currentDirection: SortDirection,
): SortDirection {
  return column === currentSort && currentDirection === "asc" ? "desc" : "asc";
}
