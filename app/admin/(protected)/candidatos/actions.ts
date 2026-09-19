"use server";

import { redirect } from "next/navigation";
import { revalidatePath, updateTag } from "next/cache";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { candidateUpsertSchema } from "@/lib/validation/schemas";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadCandidatePhoto, deleteCandidatePhoto, PhotoUploadError } from "@/lib/admin/photo-upload";
import { logAdminAction } from "@/lib/admin/audit-log";
import { requireAdminSession } from "@/lib/admin/session";
import { electionIsFrozen } from "@/lib/election/composition-freeze";
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

/** Mesmos cargos, em qualquer ordem. */
function mesmosCargos(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

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

  // Composição congelada desde a liberação da votação. A recusa é aqui, no
  // servidor: campo readOnly na tela é cortesia, não controle.
  //
  // Só é recusado o que REALMENTE muda — reenviar o mesmo nome e os mesmos
  // cargos junto com um vídeo novo continua valendo, que é o caso de uso
  // que a regra precisa preservar.
  const congelada = await electionIsFrozen();
  if (congelada) {
    if (!parsed.data.id) {
      return { error: "A votação já foi liberada: não é possível cadastrar novos candidatos." };
    }
    const { data: atual } = await supabase
      .from("candidates")
      .select("full_name, active, display_order, candidate_positions ( position_id )")
      .eq("id", parsed.data.id)
      .maybeSingle();

    if (!atual) return { error: "Candidato não encontrado." };

    const cargosAtuais = (
      (atual as unknown as { candidate_positions: { position_id: string }[] }).candidate_positions ??
      []
    ).map((row) => row.position_id);

    if (
      atual.full_name !== parsed.data.full_name ||
      atual.active !== parsed.data.active ||
      atual.display_order !== parsed.data.display_order ||
      !mesmosCargos(cargosAtuais, parsed.data.position_ids)
    ) {
      return { error: COMPOSICAO_CONGELADA };
    }
  }

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
    videoChanged = !sameVideo(previousVideoUrl, record.video_url);

    // Capa ANTES do banco: se falhar, o candidato ainda é salvo e o player
    // usa o placeholder. Se o banco falhar depois, a capa órfã é removida
    // por compensação — mas só se tiver sido criada agora.
    //
    // Chamado em TODA gravação com vídeo, não só quando o vídeo muda: é o
    // que dá capa a candidatos cadastrados antes desta funcionalidade e o
    // que permite uma nova tentativa depois de uma falha transitória.
    // Quando a capa já está lá, isto custa uma listagem e nenhum fetch.
    if (record.video_url) {
      const capa = await ensureYouTubeThumbnail(candidateId, record.video_url);
      capaCriadaAgora = capa.stored && capa.created;
    }

    const { error } = await supabase.from("candidates").update(record).eq("id", candidateId);
    if (error) {
      if (capaCriadaAgora && record.video_url) {
        await deleteYouTubeThumbnail(candidateId, record.video_url);
      }
      return { error: "Não foi possível salvar o candidato." };
    }
  } else {
    const { data, error } = await supabase.from("candidates").insert(record).select("id").single();
    if (error || !data) return { error: "Não foi possível criar o candidato." };
    const novoId = data.id as string;
    candidateId = novoId;

    // Na criação o id só existe depois do insert, então a capa vem em
    // seguida. Falhar aqui não desfaz o candidato: ele fica com o vídeo e
    // com o placeholder, e a próxima gravação tenta de novo.
    if (record.video_url) await ensureYouTubeThumbnail(novoId, record.video_url);
  }

  await supabase.from("candidate_positions").delete().eq("candidate_id", candidateId);
  const { error: positionsError } = await supabase
    .from("candidate_positions")
    .insert(parsed.data.position_ids.map((position_id) => ({ candidate_id: candidateId, position_id })));

  if (positionsError) {
    return { error: "Não foi possível salvar os cargos do candidato (máximo 2)." };
  }

  // Só agora, com o banco confirmado: a tela já aponta para a capa nova (o
  // caminho é derivado do vídeo atual), então isto é coleta de lixo — falhar
  // deixa um arquivo órfão, nunca uma capa errada em exibição.
  if (videoChanged && previousVideoUrl && candidateId) {
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
  // disputa não vai à urna). Bloqueado junto com o resto.
  if (await electionIsFrozen()) {
    throw new Error("COMPOSITION_FROZEN");
  }
  const supabase = createServiceClient();
  const { error } = await supabase.from("candidates").update({ active }).eq("id", candidateId);
  if (error) throw error;

  await logAdminAction(active ? "CANDIDATE_REACTIVATED" : "CANDIDATE_DEACTIVATED", { candidateId });
  invalidateCandidateCaches();
  revalidatePath("/admin/candidatos");
  revalidatePath("/candidatos");
}
