import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { parseYouTubeUrl, youtubeThumbnailPath } from "@/lib/media/youtube";

/**
 * Baixa a capa do vídeo NO SERVIDOR e guarda no Storage, para que o
 * navegador do visitante nunca fale com o YouTube antes de clicar em Play.
 *
 * Reutiliza o bucket `candidate-photos`: a policy de leitura pública cobre o
 * bucket inteiro, sem filtrar caminho, e o bucket já aceita image/jpeg com
 * teto de 5 MiB. Nada de bucket novo, policy nova ou migration.
 */

const BUCKET = "candidate-photos";

/** Tamanhos que o YouTube publica por vídeo, do melhor para o aceitável. */
const QUALIDADES = ["maxresdefault", "hqdefault"] as const;

const TIMEOUT_MS = 8_000;

/** Uma capa real passa disso com folga; a imagem cinza de "sem maxres" não. */
const MIN_BYTES = 4 * 1024;

/** Muito acima de qualquer maxresdefault (~150 KB), muito abaixo do teto do bucket. */
const MAX_BYTES = 2 * 1024 * 1024;

export type ThumbnailOutcome =
  | { stored: true; path: string }
  | { stored: false; reason: string };

/**
 * Monta a URL NO SERVIDOR a partir de um id já validado.
 *
 * Nenhuma string digitada pelo administrador chega ao fetch: `videoId` vem
 * de parseYouTubeUrl e casa com /^[A-Za-z0-9_-]{11}$/. É isso que fecha a
 * porta para SSRF — não há URL de usuário para seguir.
 */
function thumbnailSourceUrl(videoId: string, qualidade: string): string {
  return `https://i.ytimg.com/vi/${videoId}/${qualidade}.jpg`;
}

async function baixarCapa(videoId: string): Promise<Buffer | null> {
  for (const qualidade of QUALIDADES) {
    let resposta: Response;
    try {
      resposta = await fetch(thumbnailSourceUrl(videoId, qualidade), {
        // Um redirect vira falha em vez de levar o fetch a outro host.
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "image/jpeg,image/*" },
      });
    } catch {
      continue; // timeout ou rede: tenta a próxima qualidade
    }

    if (resposta.status !== 200) continue;

    // Content-Type real da resposta, nunca a extensão da URL.
    const tipo = (resposta.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (tipo !== "image/jpeg") continue;

    const declarado = Number(resposta.headers.get("content-length") ?? "0");
    if (declarado > MAX_BYTES) continue;

    const buffer = Buffer.from(await resposta.arrayBuffer());

    // O tamanho real também é conferido: content-length é informação do
    // outro lado, não garantia.
    if (buffer.byteLength > MAX_BYTES) continue;

    // HTTP 200 não basta. Quando não existe maxresdefault, o YouTube pode
    // devolver uma imagem cinza genérica de poucos KB — aceitá-la seria
    // trocar a capa real por um retângulo vazio.
    if (buffer.byteLength < MIN_BYTES) continue;

    return buffer;
  }

  return null;
}

/**
 * Busca e armazena a capa. Nunca lança: falhar em obter a thumbnail não pode
 * impedir o cadastro de um vídeo válido — o player cai no placeholder.
 */
export async function storeYouTubeThumbnail(
  candidateId: string,
  videoUrl: string,
): Promise<ThumbnailOutcome> {
  const video = parseYouTubeUrl(videoUrl);
  if (!video) return { stored: false, reason: "URL não reconhecida" };

  const buffer = await baixarCapa(video.videoId);
  if (!buffer) {
    console.error("youtube thumbnail: nenhuma qualidade utilizável", {
      candidateId,
      videoId: video.videoId,
    });
    return { stored: false, reason: "capa indisponível" };
  }

  const path = youtubeThumbnailPath(candidateId, video.videoId);
  const supabase = createServiceClient();
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: "image/jpeg",
    // O caminho é determinístico: regravar a mesma capa é idempotente.
    upsert: true,
  });

  if (error) {
    console.error("youtube thumbnail: upload falhou", { candidateId, path, error });
    return { stored: false, reason: "upload falhou" };
  }

  return { stored: true, path };
}

/** Remove a capa de um vídeo específico. Best-effort: só registra a falha. */
export async function deleteYouTubeThumbnail(
  candidateId: string,
  videoUrl: string,
): Promise<void> {
  const video = parseYouTubeUrl(videoUrl);
  if (!video) return;

  const path = youtubeThumbnailPath(candidateId, video.videoId);
  const supabase = createServiceClient();
  const { error } = await supabase.storage.from(BUCKET).remove([path]);

  // Arquivo órfão não corrompe a tela: o caminho exibido é derivado do vídeo
  // ATUAL, então a capa antiga simplesmente deixa de ser referenciada.
  if (error) console.error("youtube thumbnail: remoção falhou", { candidateId, path, error });
}

/** Mesmo vídeo? Compara o ID normalizado, não a string gravada. */
export function sameVideo(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = parseYouTubeUrl(a)?.videoId ?? null;
  const tb = parseYouTubeUrl(b)?.videoId ?? null;
  return ta === tb;
}
