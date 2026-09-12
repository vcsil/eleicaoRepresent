"use client";

import { useState } from "react";

function extractYouTubeId(url: string): string | null {
  const patterns = [
    /youtube\.com\/watch\?v=([\w-]{6,})/,
    /youtu\.be\/([\w-]{6,})/,
    /youtube\.com\/embed\/([\w-]{6,})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function YouTubePlayer({ url, title }: { url: string; title: string }) {
  const [playing, setPlaying] = useState(false);
  const videoId = extractYouTubeId(url);

  if (!videoId) return null;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-surface-muted">
      {playing ? (
        <iframe
          className="h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
          title={`Vídeo de apresentação — ${title}`}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="flex h-full w-full flex-col items-center justify-center gap-2 text-foreground-muted transition-colors hover:text-primary"
          aria-label={`Reproduzir vídeo de apresentação de ${title}`}
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
          <span className="text-sm font-medium">Assistir vídeo de apresentação</span>
        </button>
      )}
    </div>
  );
}
