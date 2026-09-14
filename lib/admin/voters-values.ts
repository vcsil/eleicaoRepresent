/**
 * Vocabulário da listagem de eleitores — SEM `server-only`, porque a barra de
 * pesquisa, os cabeçalhos ordenáveis e a paginação rodam no cliente e
 * precisam desses valores.
 *
 * Mesmo arranjo de lib/election/status-values.ts: aqui não há nada sensível,
 * são constantes de apresentação. A CONSULTA continua exclusivamente no
 * servidor, em lib/admin/voters.ts.
 */
export type AdminVoter = {
  id: string;
  registration_number: string;
  full_name: string;
  active: boolean;
};

export const VOTERS_PAGE_SIZE = 20;

export const VOTER_SORTS = ["registration", "name", "status"] as const;
export type VoterSort = (typeof VOTER_SORTS)[number];
export type SortDirection = "asc" | "desc";
