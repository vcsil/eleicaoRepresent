import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { youtubeThumbnailPath, youtubeThumbnailPathFor } from "@/lib/media/youtube";

const raiz = new URL("../../", import.meta.url).pathname;

function arquivosDe(pasta: string): string[] {
  const saida: string[] = [];
  const caminho = join(raiz, pasta);
  for (const nome of readdirSync(caminho)) {
    const completo = join(caminho, nome);
    if (statSync(completo).isDirectory()) saida.push(...arquivosDe(join(pasta, nome)));
    else if (/\.(ts|tsx)$/.test(nome)) saida.push(completo);
  }
  return saida;
}

/** Tudo que pode virar JavaScript no navegador. */
const arquivosDeCliente = [...arquivosDe("components"), ...arquivosDe("app")];

describe("o navegador não fala com o YouTube antes do clique", () => {
  it("nenhum componente referencia os domínios de imagem do YouTube", () => {
    // O fetch da capa é server-side; se um destes aparecer aqui, o visitante
    // voltou a ser exposto ao YouTube ao simplesmente abrir o perfil.
    const proibidos = ["i.ytimg.com", "img.youtube.com", "ytimg"];
    for (const arquivo of arquivosDeCliente) {
      const fonte = readFileSync(arquivo, "utf8");
      for (const dominio of proibidos) {
        expect(fonte, `${arquivo} referencia ${dominio}`).not.toContain(dominio);
      }
    }
  });

  it("o módulo que baixa a capa é server-only", () => {
    const fonte = readFileSync(join(raiz, "lib/admin/youtube-thumbnail.ts"), "utf8");
    expect(fonte.startsWith('import "server-only";')).toBe(true);
  });

  it("nenhum componente importa o módulo de download", () => {
    for (const arquivo of arquivosDeCliente) {
      const fonte = readFileSync(arquivo, "utf8");
      if (arquivo.includes("candidatos/actions")) continue; // Server Action
      expect(fonte, arquivo).not.toContain("youtube-thumbnail");
    }
  });

  it("o player só monta o iframe depois do clique", () => {
    const player = readFileSync(join(raiz, "components/candidates/YouTubePlayer.tsx"), "utf8");
    // O iframe fica no ramo `playing ?` do ternário: sem estado, sem embed.
    expect(player).toMatch(/\{playing \? \(\s*<iframe/);
    expect(player).toContain("onClick={() => setPlaying(true)}");
  });

  it("a capa exibida vem do Storage do Supabase", () => {
    const player = readFileSync(join(raiz, "components/candidates/YouTubePlayer.tsx"), "utf8");
    expect(player).toContain("candidatePhotoUrl(youtubeThumbnailPath(");
  });

  it("o CSP e o next.config não foram afrouxados para o YouTube", () => {
    const proxy = readFileSync(join(raiz, "proxy.ts"), "utf8");
    const config = readFileSync(join(raiz, "next.config.ts"), "utf8");
    for (const dominio of ["ytimg", "img.youtube.com"]) {
      expect(proxy, dominio).not.toContain(dominio);
      expect(config, dominio).not.toContain(dominio);
    }
    // O embed continua autorizado — e só ele.
    expect(proxy).toContain("frame-src https://www.youtube-nocookie.com");
  });
});

describe("caminho derivado, sem coluna no banco", () => {
  const ID = "ABCDEFGHIJK";

  it("deriva de candidato + vídeo", () => {
    expect(youtubeThumbnailPath("abc", ID)).toBe(`video-thumbnails/abc/${ID}.jpg`);
  });

  it("formas diferentes do mesmo vídeo dão o MESMO caminho", () => {
    const a = youtubeThumbnailPathFor("abc", `https://youtu.be/${ID}`);
    const b = youtubeThumbnailPathFor("abc", `https://www.youtube.com/watch?v=${ID}&si=x`);
    expect(a).toBe(b);
  });

  it("vídeos diferentes dão caminhos diferentes — o cache antigo não interfere", () => {
    const a = youtubeThumbnailPathFor("abc", `https://youtu.be/${ID}`);
    const b = youtubeThumbnailPathFor("abc", "https://youtu.be/ZZZZZZZZZZZ");
    expect(a).not.toBe(b);
  });

  it("sem vídeo ou sem candidato, não há caminho", () => {
    expect(youtubeThumbnailPathFor("abc", null)).toBeNull();
    expect(youtubeThumbnailPathFor("abc", "https://vimeo.com/1")).toBeNull();
    expect(youtubeThumbnailPathFor(null, `https://youtu.be/${ID}`)).toBeNull();
  });

  it("cai no bucket que já tem leitura pública, sem policy nova", () => {
    const storage = readFileSync(join(raiz, "supabase/migrations/0007_storage.sql"), "utf8");
    // A policy cobre o bucket inteiro, sem filtrar caminho.
    expect(storage).toContain("using (bucket_id = 'candidate-photos')");
    expect(storage).toContain("image/jpeg");
    expect(youtubeThumbnailPath("abc", ID).endsWith(".jpg")).toBe(true);
  });
});

describe("a capa tem fallback e não distorce", () => {
  const player = readFileSync(join(raiz, "components/candidates/YouTubePlayer.tsx"), "utf8");

  it("erro de carregamento cai no placeholder, não em ícone quebrado", () => {
    expect(player).toContain("onError={() => setCapaFalhou(true)}");
  });

  it("recorta em vez de esticar — a capa é 16:9 e o Short é 9:16", () => {
    expect(player).toContain("object-cover");
  });
});
