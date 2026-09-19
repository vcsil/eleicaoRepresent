/**
 * Interpretação de URLs do YouTube — fonte única de verdade.
 *
 * Sem `server-only`: o player roda no cliente, o schema de validação roda
 * nos dois lados e a Server Action normaliza antes de gravar. Ter três
 * parsers diferentes é como Shorts passavam na validação e sumiam da tela:
 * o formulário aceitava, o banco gravava e o player devolvia null.
 *
 * Nada aqui consulta a API do YouTube. A orientação do vídeo é inferida da
 * FORMA da URL cadastrada, porque o mesmo vídeo é alcançável por
 * /shorts/<id> e por /watch?v=<id> e, sem API, não há como distinguir os
 * dois casos — quem quiser apresentação vertical cadastra o link /shorts/.
 */

/** IDs do YouTube têm 11 caracteres do alfabeto base64url. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Comparação por igualdade exata de hostname, nunca por "contém".
 * `youtube.com.exemplo-malicioso.com` não entra aqui.
 */
const HOSTS_COM_PATH = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  // As URLs de embed que o próprio projeto gera.
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const HOSTS_CURTOS = new Set(["youtu.be", "www.youtu.be"]);

export type YouTubeFormat = "standard" | "short";

export type YouTubeVideo = {
  videoId: string;
  format: YouTubeFormat;
};

/**
 * Devolve o vídeo, ou `null` se a URL não for um link de vídeo do YouTube
 * que saibamos incorporar.
 */
export function parseYouTubeUrl(input: string | null | undefined): YouTubeVideo | null {
  if (typeof input !== "string") return null;
  const texto = input.trim();
  if (!texto) return null;

  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return null;
  }

  // Só https: um embed via http seria bloqueado como conteúdo misto.
  if (url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  const segmentos = url.pathname.split("/").filter(Boolean);

  if (HOSTS_CURTOS.has(host)) {
    // https://youtu.be/<id>
    return segmentos.length === 1 ? comVideo(segmentos[0], "standard") : null;
  }

  if (!HOSTS_COM_PATH.has(host)) return null;

  // https://www.youtube.com/watch?v=<id>
  if (segmentos.length === 1 && segmentos[0] === "watch") {
    return comVideo(url.searchParams.get("v"), "standard");
  }

  if (segmentos.length === 2) {
    const [prefixo, id] = segmentos;
    // https://www.youtube.com/shorts/<id> — a única forma vertical.
    if (prefixo === "shorts") return comVideo(id, "short");
    if (prefixo === "embed" || prefixo === "v" || prefixo === "live") {
      return comVideo(id, "standard");
    }
  }

  return null;
}

function comVideo(id: string | null | undefined, format: YouTubeFormat): YouTubeVideo | null {
  if (!id || !VIDEO_ID.test(id)) return null;
  return { videoId: id, format };
}

/** Atalho para validação — o mesmo critério que o player usa para exibir. */
export function isSupportedYouTubeUrl(input: string | null | undefined): boolean {
  return parseYouTubeUrl(input) !== null;
}

/**
 * Forma canônica para gravar no banco.
 *
 * Preserva a distinção Short/padrão, que é o que define a proporção, e
 * descarta parâmetros de rastreamento (`?si=`). Também é o que permite
 * aceitar `m.youtube.com` sem migration: a CHECK de `candidates.video_url`
 * (0002_schema.sql) só admite `(www.)?youtube.com/` e `youtu.be/`, e a
 * forma canônica sempre cai na primeira.
 */
export function canonicalYouTubeUrl(input: string | null | undefined): string | null {
  const video = parseYouTubeUrl(input);
  if (!video) return null;
  return video.format === "short"
    ? `https://www.youtube.com/shorts/${video.videoId}`
    : `https://www.youtube.com/watch?v=${video.videoId}`;
}

/**
 * Caminho da thumbnail local no bucket `candidate-photos`.
 *
 * DERIVADO de (candidateId, videoId), nunca guardado no banco. Isso tem uma
 * consequência que vale registrar: se a linha do candidato diz vídeo B, o
 * caminho calculado é o de B. A capa de A não é referenciada nunca mais,
 * tenha a limpeza funcionado ou não — o estado "banco aponta para B mas a
 * tela mostra a capa de A" é impossível por construção, não por cuidado.
 *
 * Incluir o videoId também resolve cache: trocar de vídeo troca a URL, então
 * CDN e navegador não servem a capa antiga.
 */
export function youtubeThumbnailPath(candidateId: string, videoId: string): string {
  return `video-thumbnails/${candidateId}/${videoId}.jpg`;
}

/** Caminho da thumbnail a partir da URL gravada, ou null se não houver vídeo. */
export function youtubeThumbnailPathFor(
  candidateId: string | null | undefined,
  videoUrl: string | null | undefined,
): string | null {
  if (!candidateId) return null;
  const video = parseYouTubeUrl(videoUrl);
  return video ? youtubeThumbnailPath(candidateId, video.videoId) : null;
}
