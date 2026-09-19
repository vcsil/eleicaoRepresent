import { describe, expect, it } from "vitest";
import {
  parseYouTubeUrl,
  isSupportedYouTubeUrl,
  canonicalYouTubeUrl,
} from "@/lib/media/youtube";

const ID = "ABCDEFGHIJK"; // 11 caracteres, como o YouTube usa

describe("vídeos em formato padrão (16:9)", () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
  ]) {
    it(`reconhece ${url}`, () => {
      expect(parseYouTubeUrl(url)).toEqual({ videoId: ID, format: "standard" });
    });
  }

  it("ignora parâmetros extras no watch", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&si=abc&t=42`)).toEqual({
      videoId: ID,
      format: "standard",
    });
  });

  it("ignora parâmetros extras no link curto", () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?si=abc`)).toEqual({
      videoId: ID,
      format: "standard",
    });
  });

  it("aceita espaços em volta, como num colar desatento", () => {
    expect(parseYouTubeUrl(`  https://youtu.be/${ID}  `)?.videoId).toBe(ID);
  });
});

describe("Shorts (9:16)", () => {
  it("reconhece a URL de Short", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/shorts/${ID}`)).toEqual({
      videoId: ID,
      format: "short",
    });
  });

  it("reconhece Short com parâmetro de rastreamento", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/shorts/${ID}?si=test`)).toEqual({
      videoId: ID,
      format: "short",
    });
  });

  it("reconhece Short no domínio móvel", () => {
    expect(parseYouTubeUrl(`https://m.youtube.com/shorts/${ID}`)?.format).toBe("short");
  });

  it("o MESMO vídeo em /watch continua sendo padrão", () => {
    // Sem API não há como saber que o vídeo nasceu Short: a orientação vem
    // da forma da URL cadastrada, e essa é a regra combinada.
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}`)?.format).toBe("standard");
  });
});

describe("URLs que devem ser recusadas", () => {
  const invalidas: [string, string][] = [
    ["string vazia", ""],
    ["só espaços", "   "],
    ["youtube.com sem vídeo", "https://www.youtube.com/"],
    ["watch sem o parâmetro v", "https://www.youtube.com/watch"],
    ["watch com v vazio", "https://www.youtube.com/watch?v="],
    ["shorts sem id", "https://www.youtube.com/shorts/"],
    ["canal, não vídeo", "https://www.youtube.com/@algumcanal"],
    ["playlist", `https://www.youtube.com/playlist?list=${ID}`],
    ["outro provedor", "https://vimeo.com/123456789"],
    ["http em vez de https", `http://www.youtube.com/watch?v=${ID}`],
    ["nem é URL", "youtube"],
  ];

  for (const [nome, url] of invalidas) {
    it(`recusa ${nome}`, () => {
      expect(parseYouTubeUrl(url)).toBeNull();
    });
  }

  it("recusa null e undefined", () => {
    expect(parseYouTubeUrl(null)).toBeNull();
    expect(parseYouTubeUrl(undefined)).toBeNull();
  });
});

describe("hostname é comparado por igualdade, nunca por 'contém'", () => {
  it("recusa domínio que apenas COMEÇA com youtube.com", () => {
    expect(parseYouTubeUrl(`https://youtube.com.exemplo-malicioso.com/watch?v=${ID}`)).toBeNull();
  });

  it("recusa domínio que apenas TERMINA com youtube.com", () => {
    expect(parseYouTubeUrl(`https://naoehyoutube.com/watch?v=${ID}`)).toBeNull();
  });

  it("recusa youtube.com aparecendo só na query de outro site", () => {
    // O parser antigo, por usar match() sem âncora, embedava o ID daqui.
    expect(parseYouTubeUrl(`https://exemplo.com/?x=youtube.com/watch?v=${ID}`)).toBeNull();
  });

  it("recusa youtube.com aparecendo só no caminho de outro site", () => {
    expect(parseYouTubeUrl(`https://exemplo.com/youtube.com/watch?v=${ID}`)).toBeNull();
  });

  it("recusa subdomínio não previsto", () => {
    expect(parseYouTubeUrl(`https://evil.youtube.com/watch?v=${ID}`)).toBeNull();
  });
});

describe("identificador do vídeo", () => {
  it("exige exatamente 11 caracteres", () => {
    expect(parseYouTubeUrl("https://youtu.be/abc123")).toBeNull();
    expect(parseYouTubeUrl(`https://youtu.be/${ID}X`)).toBeNull();
  });

  it("aceita hífen e sublinhado, que o YouTube usa", () => {
    expect(parseYouTubeUrl("https://youtu.be/dQw4w9-gX_Q")?.videoId).toBe("dQw4w9-gX_Q");
  });

  it("recusa caracteres fora do alfabeto do YouTube", () => {
    expect(parseYouTubeUrl("https://youtu.be/abc!@#$%^&")).toBeNull();
  });
});

describe("forma canônica gravada no banco", () => {
  it("converte qualquer forma padrão para watch?v=", () => {
    for (const url of [
      `https://youtu.be/${ID}?si=abc`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/embed/${ID}`,
    ]) {
      expect(canonicalYouTubeUrl(url), url).toBe(`https://www.youtube.com/watch?v=${ID}`);
    }
  });

  it("preserva a forma de Short — é ela que define a proporção", () => {
    expect(canonicalYouTubeUrl(`https://m.youtube.com/shorts/${ID}?si=x`)).toBe(
      `https://www.youtube.com/shorts/${ID}`,
    );
  });

  it("a forma canônica satisfaz a CHECK do banco", () => {
    // candidates.video_url ~ '^https://(www\.)?youtube\.com/|^https://youtu\.be/'
    const check = /^https:\/\/(www\.)?youtube\.com\/|^https:\/\/youtu\.be\//;
    for (const url of [
      `https://m.youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/shorts/${ID}`,
      `https://youtu.be/${ID}`,
    ]) {
      expect(check.test(canonicalYouTubeUrl(url)!), url).toBe(true);
    }
  });

  it("devolve null para URL não suportada", () => {
    expect(canonicalYouTubeUrl("https://vimeo.com/1")).toBeNull();
  });

  it("é idempotente", () => {
    const uma = canonicalYouTubeUrl(`https://youtu.be/${ID}`)!;
    expect(canonicalYouTubeUrl(uma)).toBe(uma);
  });
});

describe("isSupportedYouTubeUrl acompanha o parser", () => {
  it("aceita o que o parser aceita e recusa o que ele recusa", () => {
    expect(isSupportedYouTubeUrl(`https://www.youtube.com/shorts/${ID}`)).toBe(true);
    expect(isSupportedYouTubeUrl("https://vimeo.com/1")).toBe(false);
  });
});
