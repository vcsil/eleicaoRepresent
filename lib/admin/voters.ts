import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import {
  VOTERS_PAGE_SIZE,
  type AdminVoter,
  type VoterSort,
  type SortDirection,
} from "@/lib/admin/voters-values";

// Reexportado para os consumidores de servidor continuarem importando daqui;
// o vocabulário vive em voters-values.ts porque os componentes de lista
// precisam dele no cliente, e este módulo é server-only.
export {
  VOTERS_PAGE_SIZE,
  type AdminVoter,
  VOTER_SORTS,
  type VoterSort,
  type SortDirection,
} from "@/lib/admin/voters-values";

export type VotersPage = {
  voters: AdminVoter[];
  /** Total da BASE, ignorando a pesquisa. */
  total: number;
  /** Ativos na base, ignorando a pesquisa. */
  activeTotal: number;
  /** Total que casa com a pesquisa atual (= total quando não há pesquisa). */
  filteredTotal: number;
  page: number;
  pageCount: number;
};

/**
 * Normaliza o termo igual a `normalize_name()` no Postgres
 * (0002_schema.sql): minúsculas, sem acento, espaços colapsados.
 *
 * É o que permite "joao" encontrar "João da Silva" — a coluna
 * `normalized_name` já guarda a forma normalizada e tem índice próprio.
 * A semântica da coluna não muda; ela só passa a ser lida também aqui.
 */
function normalizeTerm(term: string): string {
  return term
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Prepara um valor para dentro de uma string de filtro do PostgREST.
 *
 * O `.or()` do supabase-js recebe uma EXPRESSÃO, onde vírgula e parênteses
 * são estruturais: um termo pesquisado contendo `,` mudaria a estrutura da
 * query. Envolver em aspas duplas (escapando `\` e `"`) mantém o valor como
 * valor. Nunca concatenamos SQL — mas a expressão de filtro merece o mesmo
 * cuidado.
 */
function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Uma página de eleitores, filtrada e ordenada PELO BANCO.
 *
 * NÃO traz `has_voted` nem `voted_at`: a tela serve para conferir a lista
 * habilitada, e quem já votou não é informação necessária para isso. O
 * andamento da votação aparece como percentual agregado no painel, sem
 * identificar ninguém.
 */
export async function getVotersPage({
  page = 1,
  query = "",
  sort = "name",
  direction = "asc",
  pageSize = VOTERS_PAGE_SIZE,
}: {
  page?: number;
  query?: string;
  sort?: VoterSort;
  direction?: SortDirection;
  pageSize?: number;
} = {}): Promise<VotersPage> {
  const supabase = createServiceClient();
  const termo = query.trim();

  function aplicarBusca<T extends { or: (f: string) => T }>(builder: T): T {
    if (!termo) return builder;
    // Matrícula é STRING: busca por trecho, preservando zeros à esquerda.
    // Nome vai por normalized_name, que já está sem acento e em minúsculas.
    const matricula = quoteFilterValue(`%${termo}%`);
    const nome = quoteFilterValue(`%${normalizeTerm(termo)}%`);
    return builder.or(`registration_number.ilike.${matricula},normalized_name.ilike.${nome}`);
  }

  // Contagens da BASE (sem a pesquisa) — `head: true` não devolve linha
  // alguma, só o total. É isso que mantém o resumo correto sem uma segunda
  // leitura grande.
  const totalQuery = supabase.from("voters").select("id", { count: "exact", head: true });
  const activeQuery = supabase
    .from("voters")
    .select("id", { count: "exact", head: true })
    .eq("active", true);

  // A página em si: o `count` vem junto e já reflete a pesquisa, então
  // filtramos -> ordenamos -> paginamos num único round trip.
  let pageQuery = aplicarBusca(
    supabase
      .from("voters")
      .select("id, registration_number, full_name, active", { count: "exact" }),
  );

  if (sort === "registration") {
    pageQuery = pageQuery.order("registration_number", { ascending: direction === "asc" });
  } else if (sort === "status") {
    // "asc" = Ativos primeiro, que é a ordem alfabética do RÓTULO exibido
    // ("Ativo" antes de "Inativo"). No banco isso é `active` DESC, porque
    // false < true em Postgres. A inversão é intencional.
    pageQuery = pageQuery.order("active", { ascending: direction !== "asc" });
  } else {
    pageQuery = pageQuery.order("full_name", { ascending: direction === "asc" });
  }
  // Desempate estável: sem isto, duas linhas com a mesma situação podem
  // trocar de lugar entre páginas e um eleitor some ou aparece duas vezes.
  if (sort !== "name") pageQuery = pageQuery.order("full_name", { ascending: true });
  pageQuery = pageQuery.order("id", { ascending: true });

  // Quantas linhas casam com a pesquisa, para saber o número de páginas
  // ANTES de pedir o intervalo — assim uma `page` fora do fim é corrigida
  // em vez de devolver lista vazia.
  const countQuery = aplicarBusca(
    supabase.from("voters").select("id", { count: "exact", head: true }),
  );

  const [totalRes, activeRes, countRes] = await Promise.all([totalQuery, activeQuery, countQuery]);
  if (totalRes.error) throw totalRes.error;
  if (activeRes.error) throw activeRes.error;
  if (countRes.error) throw countRes.error;

  const filteredTotal = countRes.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const paginaAtual = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const from = (paginaAtual - 1) * pageSize;

  const { data, error } = await pageQuery.range(from, from + pageSize - 1);
  if (error) throw error;

  return {
    voters: (data ?? []) as AdminVoter[],
    total: totalRes.count ?? 0,
    activeTotal: activeRes.count ?? 0,
    filteredTotal,
    page: paginaAtual,
    pageCount,
  };
}

/** Matrícula → nome atual, para o preview distinguir novo de já cadastrado. */
export async function getExistingRegistrations(
  registrationNumbers: string[],
): Promise<Map<string, string>> {
  if (registrationNumbers.length === 0) return new Map();

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("voters")
    .select("registration_number, full_name")
    .in("registration_number", registrationNumbers);

  if (error) throw error;

  return new Map(
    ((data ?? []) as { registration_number: string; full_name: string }[]).map((row) => [
      row.registration_number,
      row.full_name,
    ]),
  );
}
