import "server-only";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";

const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_SIZE_BYTES = 5 * 1024 * 1024;

export class PhotoUploadError extends Error {}

/**
 * Faz upload da foto do candidato ao Storage. Nunca confia no nome ou na
 * extensão do arquivo original (seção 66) — o nome é gerado no servidor a
 * partir do MIME type real detectado.
 */
export async function uploadCandidatePhoto(file: File): Promise<string> {
  if (!(file instanceof File) || file.size === 0) {
    throw new PhotoUploadError("Nenhum arquivo enviado.");
  }

  if (file.size > MAX_SIZE_BYTES) {
    throw new PhotoUploadError("A imagem deve ter no máximo 5 MB.");
  }

  const ext = ALLOWED_MIME_TO_EXT[file.type];
  if (!ext) {
    throw new PhotoUploadError("Formato de imagem não suportado. Use JPEG, PNG ou WebP.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  const path = `${randomUUID()}.${ext}`;
  const supabase = createServiceClient();
  const { error } = await supabase.storage.from("candidate-photos").upload(path, buffer, {
    contentType: file.type,
    upsert: false,
  });

  if (error) {
    throw new PhotoUploadError("Falha ao enviar a imagem. Tente novamente.");
  }

  return path;
}

export async function deleteCandidatePhoto(path: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase.storage.from("candidate-photos").remove([path]);
}
