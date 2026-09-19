"use client";

import { useState } from "react";
import Image from "next/image";
import { parseYouTubeUrl, youtubeThumbnailPath } from "@/lib/media/youtube";
import { candidatePhotoUrl } from "@/lib/media/candidate-photo";

/**
 * A proporção vem da forma da URL cadastrada (ver lib/media/youtube.ts).
 *
 * O Short é limitado em largura e centralizado: sem isso, um vídeo 9:16
 * ocupando a largura do Sheet ficaria mais alto que a viewport e o
 * administrador teria de rolar para ver o próprio vídeo. O teto de largura
 * depende da ALTURA da viewport (`60vh * 9/16`), então o vídeo cabe na tela
 * mesmo num desktop baixo — e a proporção nunca é distorcida, porque quem
 * limita é a largura, não um max-height cortando a caixa.
 */
const MOLDURA = {
  standard: "aspect-video w-full",
  short: "mx-auto aspect-[9/16] w-full max-w-[min(20rem,60vh*9/16)]",
} as const;

export function YouTubePlayer({
  url,
  title,
  candidateId,
}: {
  url: string;
  title: string;
  candidateId?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const [capaFalhou, setCapaFalhou] = useState(false);
  const video = parseYouTubeUrl(url);

  if (!video) return null;

  // A capa vem do Storage do Supabase, nunca dos servidores de imagem do
  // YouTube: o navegador só fala com o YouTube ao clicar em Play. O caminho
  // é derivado de (candidato, vídeo) e o arquivo pode ainda não existir —
  // daí o fallback para o placeholder.
  const capa =
    candidateId && !capaFalhou
      ? candidatePhotoUrl(youtubeThumbnailPath(candidateId, video.videoId))
      : null;

  return (
    // O placeholder usa a MESMA moldura do iframe: clicar não muda o layout.
    <div className={`relative overflow-hidden rounded-lg bg-surface-muted ${MOLDURA[video.format]}`}>
      {playing ? (
        <iframe
          className="h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${video.videoId}?autoplay=1`}
          title={`Vídeo de apresentação — ${title}`}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="group relative flex h-full w-full flex-col items-center justify-center gap-2 text-foreground-muted transition-colors hover:text-primary"
          aria-label={`Reproduzir vídeo de apresentação de ${title}`}
        >
          {capa && (
            <>
              {/* `fill` + object-cover: a capa do YouTube é 16:9 e o container
                  do Short é 9:16 — recortar preserva a proporção da imagem,
                  esticar a distorceria. */}
              <Image
                src={capa}
                alt=""
                fill
                sizes="(max-width: 640px) 100vw, 480px"
                className="object-cover"
                onError={() => setCapaFalhou(true)}
              />
              <span className="absolute inset-0 bg-foreground/35" aria-hidden="true" />
            </>
          )}
          <span
            className={`relative flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground ${capa ? "shadow-lg" : ""}`}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
          <span
            className={`relative text-sm font-medium ${capa ? "text-white drop-shadow" : ""}`}
          >
            Assistir vídeo de apresentação
          </span>
        </button>
      )}
    </div>
  );
}
