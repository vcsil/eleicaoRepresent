import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYouTubeUrl } from "@/lib/media/youtube";

const player = readFileSync(
  new URL("../../components/candidates/YouTubePlayer.tsx", import.meta.url),
  "utf8",
);
const schemas = readFileSync(new URL("../../lib/validation/schemas.ts", import.meta.url), "utf8");
const actions = readFileSync(
  new URL("../../app/admin/(protected)/candidatos/actions.ts", import.meta.url),
  "utf8",
);
const proxy = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");

describe("uma única fonte de verdade para URLs do YouTube", () => {
  it("o player usa o parser compartilhado, não regex própria", () => {
    expect(player).toContain('from "@/lib/media/youtube"');
    expect(player).not.toMatch(/youtube\\\.com\\\/watch/);
  });

  it("a validação usa o mesmo parser do player", () => {
    expect(schemas).toContain("isSupportedYouTubeUrl");
    // A regra antiga — "basta começar com youtube.com" — deixava passar
    // Shorts e links de canal, que depois sumiam da tela.
    expect(schemas).not.toContain("URL precisa ser do YouTube");
  });

  it("a gravação normaliza pela forma canônica", () => {
    expect(actions).toContain("canonicalYouTubeUrl");
  });
});

describe("proporção segue o formato devolvido pelo parser", () => {
  it("cada formato tem uma moldura declarada", () => {
    // O mapa é indexado por `video.format`: se um formato novo surgir sem
    // moldura, o TypeScript acusa antes de chegar aqui.
    expect(player).toContain("MOLDURA[video.format]");
    expect(player).toMatch(/standard:\s*"aspect-video/);
    expect(player).toMatch(/short:\s*"[^"]*aspect-\[9\/16\]/);
  });

  it("o Short é limitado e centralizado, não ocupa a largura toda", () => {
    const short = /short:\s*"([^"]+)"/.exec(player)?.[1] ?? "";
    expect(short).toContain("mx-auto");
    // O teto de largura depende da ALTURA da viewport: é isso que faz o
    // vídeo vertical caber num desktop baixo sem precisar rolar.
    expect(short).toMatch(/max-w-\[min\(.*vh.*\)\]/);
  });

  it("placeholder e iframe dividem a mesma moldura", () => {
    // Um único container envolve os dois ramos: clicar não muda o layout.
    const ocorrencias = player.match(/MOLDURA\[video\.format\]/g) ?? [];
    expect(ocorrencias).toHaveLength(1);
  });

  it("as URLs de exemplo caem no formato certo", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=ABCDEFGHIJK")?.format).toBe("standard");
    expect(parseYouTubeUrl("https://www.youtube.com/shorts/ABCDEFGHIJK")?.format).toBe("short");
  });
});

describe("embed e CSP", () => {
  it("continua usando youtube-nocookie", () => {
    expect(player).toContain("https://www.youtube-nocookie.com/embed/");
  });

  it("preserva os atributos de acessibilidade e carregamento", () => {
    for (const atributo of ['title={', 'loading="lazy"', "allowFullScreen", "allow="]) {
      expect(player, atributo).toContain(atributo);
    }
    expect(player).toContain("aria-label=");
  });

  it("o CSP já autoriza o domínio do embed, sem precisar afrouxar nada", () => {
    expect(proxy).toContain("frame-src https://www.youtube-nocookie.com");
  });
});
