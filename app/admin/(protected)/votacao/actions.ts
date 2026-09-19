"use server";

import { revalidatePath, updateTag } from "next/cache";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { createServiceClient } from "@/lib/supabase/service";
import { logAdminAction } from "@/lib/admin/audit-log";
import { requireAdminSession } from "@/lib/admin/session";

export type ElectionControlState = { error: string | null };

export async function closeVotingAction(
  _prevState: ElectionControlState,
  formData: FormData,
): Promise<ElectionControlState> {
  await requireAdminSession();
  const electionId = formData.get("election_id");
  if (typeof electionId !== "string") return { error: "Eleição inválida." };

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("elections")
    .update({ voting_closed_manually_at: new Date().toISOString() })
    .eq("id", electionId)
    .is("voting_closed_manually_at", null);

  if (error) return { error: "Não foi possível encerrar a votação." };

  await logAdminAction("VOTING_CLOSED_MANUALLY", { electionId });
  // voting_closed_manually_at faz parte da linha cacheada da eleição.
  updateTag(CACHE_TAGS.publicElection);
  revalidatePath("/admin/votacao");
  // A mesma action encerra a eleição geral e os desempates: o painel de
  // desempates e a página do desempate refletem o encerramento na hora.
  revalidatePath("/admin/desempates");
  revalidatePath("/admin/desempates/[runoffId]", "page");
  revalidatePath("/");
  return { error: null };
}

/**
 * Abre a votação. IRREVERSÍVEL: não existe ação para desfazer, e
 * `release_voting` nunca devolve `voting_released_at` a nulo.
 *
 * Quem decide é o Postgres — janela configurada, hora inicial já vencida,
 * eleição geral, ainda não encerrada. Aqui só traduzimos a recusa.
 */
export async function releaseVotingAction(
  _prevState: ElectionControlState,
  formData: FormData,
): Promise<ElectionControlState> {
  await requireAdminSession();
  const electionId = formData.get("election_id");
  if (typeof electionId !== "string") return { error: "Eleição inválida." };

  const supabase = createServiceClient();
  const { error } = await supabase.rpc("release_voting", { p_election_id: electionId });

  if (error) {
    const code = error.message.trim();
    if (code === "VOTING_NOT_STARTED") {
      return { error: "A votação ainda não começou pelo cronograma." };
    }
    if (code === "VOTING_WINDOW_NOT_CONFIGURED") {
      return { error: "Configure as datas da fase de votação no cronograma antes de liberar." };
    }
    if (code === "VOTING_ALREADY_CLOSED") return { error: "A votação já foi encerrada." };
    return { error: "Não foi possível liberar a votação." };
  }

  await logAdminAction("VOTING_RELEASED", { electionId });
  // voting_released_at muda o status e, com ele, a home, a urna e o painel.
  updateTag(CACHE_TAGS.publicElection);
  revalidatePath("/admin/votacao");
  revalidatePath("/admin/candidatos");
  revalidatePath("/");
  revalidatePath("/votar");
  return { error: null };
}

export async function computeResultsAction(
  _prevState: ElectionControlState,
  formData: FormData,
): Promise<ElectionControlState> {
  await requireAdminSession();
  const electionId = formData.get("election_id");
  if (typeof electionId !== "string") return { error: "Eleição inválida." };

  const supabase = createServiceClient();
  const { error } = await supabase.rpc("compute_results", { p_election_id: electionId });

  if (error) {
    const code = error.message.trim();
    if (code === "VOTING_NOT_CLOSED") return { error: "A votação ainda não foi encerrada." };
    if (code === "ALREADY_PUBLISHED") return { error: "Os resultados já foram publicados." };
    return { error: "Não foi possível apurar os resultados." };
  }

  await logAdminAction("RESULTS_COMPUTED", { electionId });
  updateTag(CACHE_TAGS.publicElection);
  revalidatePath("/admin/votacao");
  revalidatePath("/admin/resultados");
  revalidatePath("/admin/desempates");
  revalidatePath("/admin/desempates/[runoffId]", "page");
  return { error: null };
}
