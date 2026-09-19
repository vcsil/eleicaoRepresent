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

/**
 * Orçamento TOTAL da busca, não por tentativa.
 *
 * Com 8s por qualidade o pior caso era ~16s (maxres pendura, hq pendura) —
 * tempo demais segurando o administrador numa Server Action. O relógio agora
 * é compartilhado: cada tentativa recebe o que sobrou, até o teto individual.
 * O fallback não é sacrificado, porque a falha comum de maxresdefault é um
 * 404 rápido, não um travamento — o orçamento só aperta no caso raro.
 */
const BUDGET_TOTAL_MS = 8_000;
const TIMEOUT_POR_TENTATIVA_MS = 5_000;

/** Uma capa real passa disso com folga; a imagem cinza de "sem maxres" não. */
const MIN_BYTES = 4 * 1024;

/** Muito acima de qualquer maxresdefault (~150 KB), muito abaixo do teto do bucket. */
const MAX_BYTES = 2 * 1024 * 1024;

export type ThumbnailOutcome =
  /** `created` distingue "acabei de gravar" de "já estava lá" — é o que diz
   *  se uma compensação pode apagar o arquivo sem destruir capa alheia. */
  | { stored: true; path: string; created: boolean }
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
  const prazoFinal = Date.now() + BUDGET_TOTAL_MS;

  for (const qualidade of QUALIDADES) {
    const restante = prazoFinal - Date.now();
    // Sem tempo útil sobrando, tentar de novo só adiaria a resposta.
    if (restante <= 0) break;

    let resposta: Response;
    try {
      resposta = await fetch(thumbnailSourceUrl(videoId, qualidade), {
        // Um redirect vira falha em vez de levar o fetch a outro host.
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(TIMEOUT_POR_TENTATIVA_MS, restante)),
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

  return { stored: true, path, created: true };
}

/**
 * Existe o objeto derivado no Storage?
 *
 * Uma listagem de metadados, não um download: custa pouco e é o que permite
 * chamar `ensureYouTubeThumbnail` em toda gravação sem baixar nada à toa.
 */
async function thumbnailJaExiste(path: string): Promise<boolean> {
  const barra = path.lastIndexOf("/");
  const pasta = path.slice(0, barra);
  const arquivo = path.slice(barra + 1);

  const supabase = createServiceClient();
  const { data, error } = await supabase.storage.from(BUCKET).list(pasta, {
    search: arquivo,
    limit: 100,
  });

  if (error) {
    // Na dúvida, assume que não existe: baixar de novo é desperdício
    // recuperável, deixar o candidato sem capa para sempre não é.
    console.error("youtube thumbnail: listagem falhou", { path, error });
    return false;
  }

  // `search` no Supabase é prefixo, não igualdade — daí a conferência exata.
  return (data ?? []).some((objeto) => objeto.name === arquivo);
}

/**
 * Garante que a capa exista, baixando só quando faltar.
 *
 * Existe porque `sameVideo` sozinho não bastava: candidatos cadastrados
 * ANTES desta funcionalidade nunca teriam capa, e uma falha transitória no
 * primeiro download ficaria permanente — salvar o mesmo vídeo de novo não
 * tentava outra vez. A pergunta certa não é "o vídeo mudou?", é "a capa
 * está lá?".
 *
 * A regra de não baixar à toa continua valendo: com a capa presente, o
 * custo é uma listagem de metadados e nenhum fetch ao YouTube.
 */
export async function ensureYouTubeThumbnail(
  candidateId: string,
  videoUrl: string,
): Promise<ThumbnailOutcome> {
  const video = parseYouTubeUrl(videoUrl);
  if (!video) return { stored: false, reason: "URL não reconhecida" };

  const path = youtubeThumbnailPath(candidateId, video.videoId);
  if (await thumbnailJaExiste(path)) {
    return { stored: true, path, created: false };
  }

  return storeYouTubeThumbnail(candidateId, videoUrl);
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
