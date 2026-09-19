"use server";

import { redirect } from "next/navigation";
import { revalidatePath, updateTag } from "next/cache";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { candidateUpsertSchema } from "@/lib/validation/schemas";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadCandidatePhoto, deleteCandidatePhoto, PhotoUploadError } from "@/lib/admin/photo-upload";
import { logAdminAction } from "@/lib/admin/audit-log";
import { requireAdminSession } from "@/lib/admin/session";
import { canonicalYouTubeUrl } from "@/lib/media/youtube";

export type CandidateFormState = { error: string | null };

/**
 * Qualquer alteração em candidato (criar, editar, ativar, desativar,
 * trocar cargo, foto, vídeo) muda tanto a lista pública quanto as opções
 * da urna — a urna nunca pode servir um candidato desatualizado.
 * `updateTag` expira imediatamente e dá read-your-own-writes.
 */
function invalidateCandidateCaches(): void {
  updateTag(CACHE_TAGS.candidates);
  updateTag(CACHE_TAGS.ballotOptions);
}

export async function upsertCandidateAction(
  _prevState: CandidateFormState,
  formData: FormData,
): Promise<CandidateFormState> {
  await requireAdminSession();
  const id = formData.get("id");
  const positionIds = [formData.get("position_id_1"), formData.get("position_id_2")].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

  const parsed = candidateUpsertSchema.safeParse({
    id: typeof id === "string" && id.length > 0 ? id : undefined,
    full_name: formData.get("full_name"),
    tagline: formData.get("tagline") || null,
    presentation: formData.get("presentation") || null,
    proposals: formData.get("proposals") || null,
    video_url: formData.get("video_url") || "",
    active: formData.get("active") === "on",
    display_order: Number(formData.get("display_order") || 0),
    position_ids: positionIds,
  });

  if (!parsed.success) {
    return { error: "Verifique os campos do formulário: " + parsed.error.issues[0]?.message };
  }

  const supabase = createServiceClient();
  let photoPath: string | undefined;

  const photoFile = formData.get("photo");
  if (photoFile instanceof File && photoFile.size > 0) {
    try {
      photoPath = await uploadCandidatePhoto(photoFile);
    } catch (err) {
      if (err instanceof PhotoUploadError) {
        return { error: err.message };
      }
      throw err;
    }
  }

  const record = {
    full_name: parsed.data.full_name,
    tagline: parsed.data.tagline || null,
    presentation: parsed.data.presentation || null,
    proposals: parsed.data.proposals || null,
    // Grava a forma canônica: preserva Short vs padrão (é ela que define a
    // proporção), descarta parâmetros de rastreamento e mantém m.youtube.com
    // dentro da CHECK de candidates.video_url, sem precisar de migration.
    video_url: canonicalYouTubeUrl(parsed.data.video_url),
    active: parsed.data.active,
    display_order: parsed.data.display_order,
    ...(photoPath ? { photo_path: photoPath } : {}),
  };

  let candidateId = parsed.data.id;
  let previousPhotoPath: string | null = null;

  if (candidateId) {
    const { data: existing } = await supabase
      .from("candidates")
      .select("photo_path")
      .eq("id", candidateId)
      .maybeSingle();
    previousPhotoPath = existing?.photo_path ?? null;

    const { error } = await supabase.from("candidates").update(record).eq("id", candidateId);
    if (error) return { error: "Não foi possível salvar o candidato." };
  } else {
    const { data, error } = await supabase.from("candidates").insert(record).select("id").single();
    if (error || !data) return { error: "Não foi possível criar o candidato." };
    candidateId = data.id;
  }

  await supabase.from("candidate_positions").delete().eq("candidate_id", candidateId);
  const { error: positionsError } = await supabase
    .from("candidate_positions")
    .insert(parsed.data.position_ids.map((position_id) => ({ candidate_id: candidateId, position_id })));

  if (positionsError) {
    return { error: "Não foi possível salvar os cargos do candidato (máximo 2)." };
  }

  if (photoPath && previousPhotoPath) {
    await deleteCandidatePhoto(previousPhotoPath);
  }

  await logAdminAction(parsed.data.id ? "CANDIDATE_UPDATED" : "CANDIDATE_CREATED", {
    candidateId,
    fullName: parsed.data.full_name,
  });

  invalidateCandidateCaches();
  revalidatePath("/admin/candidatos");
  revalidatePath("/candidatos");
  redirect("/admin/candidatos");
}

export async function setCandidateActiveAction(candidateId: string, active: boolean): Promise<void> {
  await requireAdminSession();
  const supabase = createServiceClient();
  const { error } = await supabase.from("candidates").update({ active }).eq("id", candidateId);
  if (error) throw error;

  await logAdminAction(active ? "CANDIDATE_REACTIVATED" : "CANDIDATE_DEACTIVATED", { candidateId });
  invalidateCandidateCaches();
  revalidatePath("/admin/candidatos");
  revalidatePath("/candidatos");
}
