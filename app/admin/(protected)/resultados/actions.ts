"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/service";
import { logAdminAction } from "@/lib/admin/audit-log";

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
  const electionId = formData.get("election_id");
  if (typeof electionId !== "string") return { error: "Eleição inválida." };

  const supabase = createServiceClient();
  const { error } = await supabase.rpc("publish_results", { p_election_id: electionId });

  if (error) {
    const code = error.message.trim();
    return { error: ERROR_MESSAGES[code] ?? "Não foi possível publicar os resultados." };
  }

  await logAdminAction("RESULTS_PUBLISHED", { electionId });
  revalidatePath("/admin/resultados");
  revalidatePath("/resultados");
  revalidatePath("/");
  return { error: null };
}
