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
import {
  ensureYouTubeThumbnail,
  deleteYouTubeThumbnail,
  sameVideo,
} from "@/lib/admin/youtube-thumbnail";

export type CandidateFormState = { error: string | null };

const COMPOSICAO_CONGELADA =
  "A votação já foi liberada: a composição da eleição não pode mais mudar. " +
  "Foto, frase, apresentação, propostas e vídeo continuam editáveis.";

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

  // Forma canônica do vídeo: preserva Short vs padrão (é ela que define a
  // proporção), descarta parâmetros de rastreamento e mantém m.youtube.com
  // dentro da CHECK de candidates.video_url.
  const videoUrl = canonicalYouTubeUrl(parsed.data.video_url);

  let candidateId = parsed.data.id;
  let previousPhotoPath: string | null = null;
  let previousVideoUrl: string | null = null;
  let videoChanged = false;
  // Só a capa que ESTA gravação criou pode ser desfeita por compensação.
  let capaCriadaAgora = false;

  if (candidateId) {
    const { data: existing } = await supabase
      .from("candidates")
      .select("photo_path, video_url")
      .eq("id", candidateId)
      .maybeSingle();
    previousPhotoPath = existing?.photo_path ?? null;
    previousVideoUrl = existing?.video_url ?? null;

    // O vídeo mudou? A comparação é pelo ID normalizado: trocar
    // youtu.be/ID por watch?v=ID é o MESMO vídeo e não pode disparar um
    // novo download nem apagar a capa existente.
    videoChanged = !sameVideo(previousVideoUrl, videoUrl);

    // Capa ANTES do banco: se falhar, o candidato ainda é salvo e o player
    // usa o placeholder. Se o banco falhar depois, a capa órfã é removida
    // por compensação — mas só se tiver sido criada agora.
    //
    // Fora da transação de propósito: `save_candidate` trava a linha da
    // eleição, e segurar esse lock durante um download externo bloquearia
    // a liberação da votação por segundos.
    if (videoUrl) {
      const capa = await ensureYouTubeThumbnail(candidateId, videoUrl);
      capaCriadaAgora = capa.stored && capa.created;
    }
  }

  // Uma transação: verifica o congelamento com a linha da eleição travada,
  // grava o candidato e ajusta os cargos só se o conjunto mudou. Nada aqui
  // pode ficar pela metade, e nada pode escapar por entre duas chamadas.
  const { data: savedId, error } = await supabase.rpc("save_candidate", {
    p_candidate_id: candidateId ?? null,
    p_full_name: parsed.data.full_name,
    p_tagline: parsed.data.tagline || null,
    p_presentation: parsed.data.presentation || null,
    p_proposals: parsed.data.proposals || null,
    p_video_url: videoUrl || null,
    p_active: parsed.data.active,
    p_display_order: parsed.data.display_order,
    p_position_ids: parsed.data.position_ids,
    p_photo_path: photoPath ?? null,
  });

  if (error) {
    // A capa recém-criada vira lixo se a gravação não aconteceu.
    if (capaCriadaAgora && candidateId && videoUrl) {
      await deleteYouTubeThumbnail(candidateId, videoUrl);
    }
    const code = error.message.trim();
    if (code === "COMPOSITION_FROZEN") return { error: COMPOSICAO_CONGELADA };
    if (code === "COMPOSITION_FROZEN_CREATE") {
      return { error: "A votação já foi liberada: não é possível cadastrar novos candidatos." };
    }
    if (code === "DUPLICATE_POSITIONS") return { error: "Escolha dois cargos diferentes." };
    if (code === "INVALID_POSITIONS") {
      return { error: "Selecione um ou dois cargos válidos para o candidato." };
    }
    if (code === "CANDIDATE_NOT_FOUND") return { error: "Candidato não encontrado." };
    return { error: parsed.data.id ? "Não foi possível salvar o candidato." : "Não foi possível criar o candidato." };
  }

  const eraCriacao = !candidateId;
  candidateId = savedId as string;

  // Na criação o id só existe depois da gravação, então a capa vem em
  // seguida. Falhar aqui não desfaz o candidato: ele fica com o vídeo e o
  // placeholder, e a próxima gravação tenta de novo.
  if (eraCriacao && videoUrl) {
    await ensureYouTubeThumbnail(candidateId, videoUrl);
  }

  // Só agora, com o banco confirmado: a tela já aponta para a capa nova (o
  // caminho é derivado do vídeo atual), então isto é coleta de lixo — falhar
  // deixa um arquivo órfão, nunca uma capa errada em exibição.
  if (videoChanged && previousVideoUrl) {
    await deleteYouTubeThumbnail(candidateId, previousVideoUrl);
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
  // Ativar/inativar é o caminho mais curto para mudar a composição: um
  // candidato a menos pode tirar o cargo inteiro da cédula (cargo sem
  // disputa não vai à urna). A recusa acontece no banco, com a linha da
  // eleição travada — uma verificação em TypeScript antes da escrita
  // deixaria passar quem chegasse junto com a liberação.
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("set_candidate_active", {
    p_candidate_id: candidateId,
    p_active: active,
  });
  if (error) throw new Error(error.message.trim());

  await logAdminAction(active ? "CANDIDATE_REACTIVATED" : "CANDIDATE_DEACTIVATED", { candidateId });
  invalidateCandidateCaches();
  revalidatePath("/admin/candidatos");
  revalidatePath("/candidatos");
}
