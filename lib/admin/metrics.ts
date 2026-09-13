import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { ELECTION_STATUSES, type ElectionStatus } from "@/lib/election/status-values";

export type DashboardMetrics = {
  status: ElectionStatus;
  participation: number;
  totalVoters: number;
  totalCandidates: number;
  totalSiteViews: number;
  validationAttempts: number;
  invalidAttempts: number;
  duplicateVoteAttempts: number;
  securityEvents: number;
  tiesPending: number;
  dualWinnersPending: number;
  resultsComputed: boolean;
  resultsPublished: boolean;
};

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Painel administrativo em um único round trip.
 *
 * Antes eram 7 consultas paralelas, duas delas trazendo TODAS as linhas de
 * `security_events` e de `site_access_stats` para contar e somar em
 * JavaScript — custo que crescia sem limite conforme o site fosse usado.
 * Agora a agregação acontece no Postgres, em `get_admin_dashboard_metrics`.
 *
 * A função é restrita a service_role (revoke de anon/authenticated na
 * migration 0012): contagens de eventos de segurança não podem ser
 * alcançáveis com a chave pública.
 *
 * Inclui status e participação — diferente da função pública, que só
 * devolve participação durante a votação. O admin precisa do número em
 * qualquer fase.
 */
export async function getDashboardMetrics(electionId: string): Promise<DashboardMetrics> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("get_admin_dashboard_metrics", {
    p_election_id: electionId,
  });
  if (error) throw error;

  const row = (data ?? {}) as Record<string, unknown>;
  const status = row.status;
  if (typeof status !== "string" || !(ELECTION_STATUSES as readonly string[]).includes(status)) {
    throw new Error("get_admin_dashboard_metrics returned an unknown status");
  }

  return {
    status: status as ElectionStatus,
    participation: toNumber(row.participation),
    totalVoters: toNumber(row.total_voters),
    totalCandidates: toNumber(row.total_candidates),
    totalSiteViews: toNumber(row.total_site_views),
    validationAttempts: toNumber(row.validation_attempts),
    invalidAttempts: toNumber(row.invalid_attempts),
    duplicateVoteAttempts: toNumber(row.duplicate_vote_attempts),
    securityEvents: toNumber(row.security_events),
    tiesPending: toNumber(row.ties_pending),
    dualWinnersPending: toNumber(row.dual_winners_pending),
    resultsComputed: row.results_computed === true,
    resultsPublished: row.results_published === true,
  };
}
