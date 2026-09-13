"use server";

import { revalidatePath, updateTag } from "next/cache";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { createServiceClient } from "@/lib/supabase/service";
import { logAdminAction } from "@/lib/admin/audit-log";
import { requireAdminSession } from "@/lib/admin/session";

export type PublishState = { error: string | null };

const ERROR_MESSAGES: Record<string, string> = {
  RESULTS_NOT_COMPUTED: "É preciso iniciar a apuração antes de publicar os resultados.",
  TIE_PENDING: "Há empates pendentes de desempate. Resolva-os antes de publicar.",
  DUAL_WINNER_PENDING: "Há candidatos eleitos em dois cargos aguardando decisão.",
  RUNOFF_PENDING: "Há uma votação de desempate ainda não concluída.",
};

export async function publishResultsAction(
  _prevState: PublishState,
  formData: FormData,
): Promise<PublishState> {
  await requireAdminSession();
  const electionId = formData.get("election_id");
  if (typeof electionId !== "string") return { error: "Eleição inválida." };

  const supabase = createServiceClient();
  const { error } = await supabase.rpc("publish_results", { p_election_id: electionId });

  if (error) {
    const code = error.message.trim();
    return { error: ERROR_MESSAGES[code] ?? "Não foi possível publicar os resultados." };
  }

  await logAdminAction("RESULTS_PUBLISHED", { electionId });
  // A publicação muda results_published_at (linha da eleição) e libera as
  // linhas de result_snapshots pela RLS — ambos precisam sair do cache.
  updateTag(CACHE_TAGS.publishedResults);
  updateTag(CACHE_TAGS.publicElection);
  revalidatePath("/admin/resultados");
  // Publicar um desempate resolve o empate do pai na mesma transação: a
  // pendência some da lista e o card vira "concluído".
  revalidatePath("/admin/desempates");
  revalidatePath("/admin/desempates/[runoffId]", "page");
  revalidatePath("/resultados");
  revalidatePath("/");
  return { error: null };
}
