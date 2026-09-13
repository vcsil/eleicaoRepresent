"use server";

import { revalidatePath, updateTag } from "next/cache";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { dualWinnerDecisionSchema, runoffCreateSchema } from "@/lib/validation/schemas";
import { createServiceClient } from "@/lib/supabase/service";
import { logAdminAction } from "@/lib/admin/audit-log";

export type ActionState = { error: string | null };

export async function resolveDualWinnerAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = dualWinnerDecisionSchema.safeParse({
    decision_id: formData.get("decision_id"),
    chosen_position_id: formData.get("chosen_position_id"),
  });
  if (!parsed.success) return { error: "Seleção inválida." };

  const supabase = createServiceClient();
  const { error } = await supabase.rpc("resolve_dual_winner_decision", {
    p_decision_id: parsed.data.decision_id,
    p_chosen_position_id: parsed.data.chosen_position_id,
  });

  if (error) return { error: "Não foi possível registrar a decisão." };

  await logAdminAction("DUAL_WINNER_RESOLVED", parsed.data);
  // Resolver cargo duplo promove o próximo colocado: a composição
  // publicada muda.
  updateTag(CACHE_TAGS.publishedResults);
  revalidatePath("/admin/desempates");
  revalidatePath("/admin/resultados");
  return { error: null };
}

export async function createRunoffAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parentElectionId = formData.get("parent_election_id");
  const candidateIds = formData.getAll("candidate_ids").filter((v): v is string => typeof v === "string");

  const parsed = runoffCreateSchema.safeParse({
    position_id: formData.get("position_id"),
    candidate_ids: candidateIds,
    votes_per_voter: Number(formData.get("votes_per_voter")),
    vacancies: Number(formData.get("vacancies")),
    reason: formData.get("reason"),
    starts_on: formData.get("starts_on"),
    ends_on: formData.get("ends_on"),
    start_time: formData.get("start_time"),
    end_time: formData.get("end_time"),
  });

  if (typeof parentElectionId !== "string" || !parsed.success) {
    return { error: "Verifique os campos do formulário de desempate." };
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("create_runoff_election", {
    p_parent_election_id: parentElectionId,
    p_position_id: parsed.data.position_id,
    p_candidate_ids: parsed.data.candidate_ids,
    p_votes_per_voter: parsed.data.votes_per_voter,
    p_vacancies: parsed.data.vacancies,
    p_reason: parsed.data.reason,
    p_starts_on: parsed.data.starts_on,
    p_ends_on: parsed.data.ends_on,
    p_start_time: parsed.data.start_time,
    p_end_time: parsed.data.end_time,
  });

  if (error) return { error: "Não foi possível criar a votação de desempate." };

  await logAdminAction("RUNOFF_CREATED", { runoffId: data, ...parsed.data });
  // Um desempate pendente muda o status público da eleição principal.
  updateTag(CACHE_TAGS.publicElection);
  revalidatePath("/admin/desempates");
  return { error: null };
}
