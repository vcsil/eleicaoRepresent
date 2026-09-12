import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type DashboardMetrics = {
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

export async function getDashboardMetrics(electionId: string): Promise<DashboardMetrics> {
  const supabase = createServiceClient();

  const [
    voters,
    candidates,
    siteViews,
    securityEventsByType,
    election,
    tiesPending,
    dualWinnersPending,
  ] = await Promise.all([
    supabase.from("voters").select("id", { count: "exact", head: true }).eq("active", true),
    supabase.from("candidates").select("id", { count: "exact", head: true }).eq("active", true),
    supabase.from("site_access_stats").select("views"),
    supabase.from("security_events").select("type"),
    supabase
      .from("elections")
      .select("results_computed_at, results_published_at")
      .eq("id", electionId)
      .maybeSingle(),
    supabase
      .from("result_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("election_id", electionId)
      .eq("tie_break_needed", true),
    supabase
      .from("position_dual_winner_decisions")
      .select("id", { count: "exact", head: true })
      .eq("election_id", electionId)
      .eq("status", "pending"),
  ]);

  const totalSiteViews = (siteViews.data ?? []).reduce((sum, row) => sum + (row.views ?? 0), 0);
  const eventTypes = (securityEventsByType.data ?? []).map((r) => r.type as string);

  return {
    totalVoters: voters.count ?? 0,
    totalCandidates: candidates.count ?? 0,
    totalSiteViews,
    validationAttempts: eventTypes.filter(
      (t) => t === "INVALID_VOTER_VALIDATION" || t === "DUPLICATE_VOTE_ATTEMPT",
    ).length,
    invalidAttempts: eventTypes.filter((t) => t === "INVALID_VOTER_VALIDATION").length,
    duplicateVoteAttempts: eventTypes.filter((t) => t === "DUPLICATE_VOTE_ATTEMPT").length,
    securityEvents: eventTypes.length,
    tiesPending: tiesPending.count ?? 0,
    dualWinnersPending: dualWinnersPending.count ?? 0,
    resultsComputed: Boolean(election.data?.results_computed_at),
    resultsPublished: Boolean(election.data?.results_published_at),
  };
}
