import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Busca e armazenamento da capa do vídeo.
 *
 * Nenhum teste toca a rede: `fetch` é substituído. O que interessa aqui é
 * QUAL URL o servidor monta (nunca uma digitada pelo administrador), o que
 * ele aceita como imagem válida, e o que acontece quando falha.
 */
const ID = "ABCDEFGHIJK";
const CANDIDATO = "11111111-1111-4111-8111-111111111111";

const uploads: { path: string; contentType: string; bytes: number }[] = [];
const removals: string[][] = [];
const listagens: { pasta: string; busca: string | undefined }[] = [];
let uploadError: unknown = null;
/** Objetos que o Storage "já tem". */
let existentes: string[] = [];
let listError: unknown = null;

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    storage: {
      from: () => ({
        upload: async (path: string, body: Buffer, opts: { contentType: string }) => {
          uploads.push({ path, contentType: opts.contentType, bytes: body.byteLength });
          return { error: uploadError };
        },
        remove: async (paths: string[]) => {
          removals.push(paths);
          return { error: null };
        },
        list: async (pasta: string, opts: { search?: string }) => {
          listagens.push({ pasta, busca: opts?.search });
          if (listError) return { data: null, error: listError };
          const nomes = existentes
            .filter((caminho) => caminho.startsWith(`${pasta}/`))
            .map((caminho) => caminho.slice(pasta.length + 1));
          return { data: nomes.map((name) => ({ name })), error: null };
        },
      }),
    },
  }),
}));

const { storeYouTubeThumbnail, ensureYouTubeThumbnail, deleteYouTubeThumbnail, sameVideo } =
  await import("@/lib/admin/youtube-thumbnail");

type Resposta = { status: number; type?: string; bytes?: number; erro?: boolean };

const pedidos: string[] = [];
const opcoesUsadas: RequestInit[] = [];

/** Encadeia respostas na ordem em que o módulo tentar cada qualidade. */
function responder(sequencia: Resposta[]) {
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    pedidos.push(String(url));
    opcoesUsadas.push(init ?? {});
    const r = sequencia[Math.min(i++, sequencia.length - 1)];
    if (r.erro) throw new Error("rede");
    return {
      status: r.status,
      headers: new Headers(
        r.type ? { "content-type": r.type, "content-length": String(r.bytes ?? 0) } : {},
      ),
      arrayBuffer: async () => new Uint8Array(r.bytes ?? 0).buffer,
    } as unknown as Response;
  });
}

const capaValida: Resposta = { status: 200, type: "image/jpeg", bytes: 120_000 };

beforeEach(() => {
  uploads.length = 0;
  removals.length = 0;
  pedidos.length = 0;
  opcoesUsadas.length = 0;
  listagens.length = 0;
  existentes = [];
  uploadError = null;
  listError = null;
  vi.unstubAllGlobals();
});

describe("origem da imagem", () => {
  it("monta a URL no servidor a partir do videoId, nunca da URL digitada", async () => {
    responder([capaValida]);
    await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}?si=rastreio`);

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toBe(`https://i.ytimg.com/vi/${ID}/maxresdefault.jpg`);
    // O parâmetro de rastreamento do administrador não chega ao fetch.
    expect(pedidos[0]).not.toContain("rastreio");
  });

  it("nenhuma requisição parte de uma URL não reconhecida", async () => {
    responder([capaValida]);
    const r = await storeYouTubeThumbnail(CANDIDATO, "https://exemplo-malicioso.com/x.jpg");

    expect(r).toEqual({ stored: false, reason: "URL não reconhecida" });
    expect(pedidos).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it("não segue redirect, para não acabar noutro host", async () => {
    responder([capaValida]);
    await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);
    expect(opcoesUsadas[0].redirect).toBe("manual");
  });

  it("aborta por timeout em vez de ficar pendurado", async () => {
    responder([capaValida]);
    await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);
    expect(opcoesUsadas[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fallback de qualidade", () => {
  it("usa maxresdefault quando existe", async () => {
    responder([capaValida]);
    const r = await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);
    expect(r).toEqual({ stored: true, path: `video-thumbnails/${CANDIDATO}/${ID}.jpg`, created: true });
    expect(pedidos).toEqual([`https://i.ytimg.com/vi/${ID}/maxresdefault.jpg`]);
  });

  it("cai para hqdefault quando maxres não existe (404)", async () => {
    responder([{ status: 404 }, capaValida]);
    const r = await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);
    expect(r).toMatchObject({ stored: true });
    expect(pedidos[1]).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  });

  it("cai para hqdefault quando maxres devolve a imagem cinza de poucos KB", async () => {
    // HTTP 200 não basta: o YouTube às vezes serve um placeholder minúsculo.
    responder([{ status: 200, type: "image/jpeg", bytes: 1_200 }, capaValida]);
    const r = await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);
    expect(r).toMatchObject({ stored: true });
    expect(uploads[0].bytes).toBe(120_000);
  });

  it("cai para hqdefault quando maxres expira por timeout", async () => {
    responder([{ status: 0, erro: true }, capaValida]);
    expect(await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`)).toMatchObject({
      stored: true,
    });
  });

  it("nenhuma qualidade utilizável não é armazenada", async () => {
    responder([{ status: 404 }, { status: 404 }]);
    const r = await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);
    expect(r).toEqual({ stored: false, reason: "capa indisponível" });
    expect(uploads).toHaveLength(0);
  });
});

describe("validação do arquivo", () => {
  it("recusa Content-Type que não seja JPEG", async () => {
    responder([{ status: 200, type: "text/html", bytes: 120_000 }]);
    expect(await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`)).toMatchObject({
      stored: false,
    });
    expect(uploads).toHaveLength(0);
  });

  it("recusa arquivo acima do limite", async () => {
    responder([{ status: 200, type: "image/jpeg", bytes: 5 * 1024 * 1024 }]);
    expect(await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`)).toMatchObject({
      stored: false,
    });
    expect(uploads).toHaveLength(0);
  });

  it("grava sempre como image/jpeg, com nome gerado pelo servidor", async () => {
    responder([capaValida]);
    await storeYouTubeThumbnail(CANDIDATO, `https://www.youtube.com/shorts/${ID}`);
    expect(uploads[0]).toMatchObject({
      path: `video-thumbnails/${CANDIDATO}/${ID}.jpg`,
      contentType: "image/jpeg",
    });
  });

  it("falha de upload não lança — o candidato ainda pode ser salvo", async () => {
    responder([capaValida]);
    uploadError = { message: "storage fora do ar" };
    const r = await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);
    expect(r).toEqual({ stored: false, reason: "upload falhou" });
  });
});

describe("recuperação: a capa existe ou é gerada", () => {
  const CAMINHO = `video-thumbnails/${CANDIDATO}/${ID}.jpg`;

  it("candidato ANTIGO, com vídeo e sem capa, ganha a capa mesmo sem o vídeo mudar", async () => {
    // Cadastrado antes desta funcionalidade: nunca passou por um "vídeo
    // mudou". Sem o ensure, ficaria no placeholder para sempre.
    responder([capaValida]);
    const r = await ensureYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);

    expect(r).toEqual({ stored: true, path: CAMINHO, created: true });
    expect(uploads).toHaveLength(1);
  });

  it("capa já presente: nenhum fetch ao YouTube", async () => {
    responder([capaValida]);
    existentes = [CAMINHO];

    const r = await ensureYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);

    expect(r).toEqual({ stored: true, path: CAMINHO, created: false });
    // A regra de não baixar à toa continua valendo: custou uma listagem.
    expect(pedidos).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(listagens).toHaveLength(1);
  });

  it("nova tentativa depois de uma falha anterior, com o MESMO vídeo", async () => {
    // Primeira gravação: o YouTube estava fora e nada foi armazenado.
    responder([{ status: 500 }, { status: 500 }]);
    expect(await ensureYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`)).toMatchObject({
      stored: false,
    });
    expect(uploads).toHaveLength(0);

    // Segunda gravação do mesmo candidato, mesmo vídeo: tenta de novo.
    pedidos.length = 0;
    responder([capaValida]);
    expect(await ensureYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`)).toMatchObject({
      stored: true,
      created: true,
    });
    expect(uploads).toHaveLength(1);
  });

  it("a listagem procura o arquivo exato na pasta do candidato", async () => {
    responder([capaValida]);
    await ensureYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);
    expect(listagens[0]).toEqual({
      pasta: `video-thumbnails/${CANDIDATO}`,
      busca: `${ID}.jpg`,
    });
  });

  it("outro arquivo na mesma pasta não conta como a capa deste vídeo", async () => {
    // `search` do Supabase é prefixo, não igualdade.
    responder([capaValida]);
    existentes = [`video-thumbnails/${CANDIDATO}/ZZZZZZZZZZZ.jpg`];

    expect(await ensureYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`)).toMatchObject({
      created: true,
    });
    expect(uploads).toHaveLength(1);
  });

  it("listagem indisponível: BAIXA em vez de supor que a capa existe", async () => {
    // Baixar de novo é desperdício recuperável; supor que existe deixaria o
    // candidato sem capa para sempre. `stored: true` sozinho não distingue
    // os dois casos — o que prova a diferença é ter havido fetch e upload.
    responder([capaValida]);
    listError = { message: "storage instável" };

    const r = await ensureYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);

    expect(r).toMatchObject({ stored: true, created: true });
    expect(pedidos).toHaveLength(1);
    expect(uploads).toHaveLength(1);
  });

  it("URL irreconhecível nem chega a listar", async () => {
    responder([capaValida]);
    expect(await ensureYouTubeThumbnail(CANDIDATO, "https://vimeo.com/1")).toMatchObject({
      stored: false,
    });
    expect(listagens).toHaveLength(0);
    expect(pedidos).toHaveLength(0);
  });
});

describe("orçamento de tempo", () => {
  it("o prazo é TOTAL, não por tentativa", async () => {
    responder([{ status: 404 }, capaValida]);
    await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);

    const [primeiro, segundo] = opcoesUsadas.map((o) => o.signal as AbortSignal);
    expect(primeiro).toBeInstanceOf(AbortSignal);
    expect(segundo).toBeInstanceOf(AbortSignal);
    // Duas tentativas de 5s dariam 10s; o teto total é 8s, então a segunda
    // recebe o que sobrou — é isso que derruba o pior caso de ~16s.
    const fonte = readFileSync(
      new URL("../../lib/admin/youtube-thumbnail.ts", import.meta.url),
      "utf8",
    );
    expect(fonte).toContain("BUDGET_TOTAL_MS");
    expect(fonte).toContain("Math.min(TIMEOUT_POR_TENTATIVA_MS, restante)");
  });

  it("sem tempo restante, não inicia outra tentativa", async () => {
    // Primeira tentativa consome todo o orçamento.
    let primeira = true;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      pedidos.push(String(url));
      opcoesUsadas.push(init ?? {});
      if (primeira) {
        primeira = false;
        await new Promise((r) => setTimeout(r, 30));
        vi.setSystemTime(Date.now() + 9_000);
        throw new Error("timeout");
      }
      throw new Error("não deveria chegar aqui");
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await storeYouTubeThumbnail(CANDIDATO, `https://youtu.be/${ID}`);
    expect(pedidos).toHaveLength(1);

    vi.useRealTimers();
  });
});

describe("remoção", () => {
  it("remove pelo caminho derivado do vídeo", async () => {
    await deleteYouTubeThumbnail(CANDIDATO, `https://www.youtube.com/watch?v=${ID}`);
    expect(removals).toEqual([[`video-thumbnails/${CANDIDATO}/${ID}.jpg`]]);
  });

  it("não tenta remover nada para URL irreconhecível", async () => {
    await deleteYouTubeThumbnail(CANDIDATO, "https://vimeo.com/1");
    expect(removals).toHaveLength(0);
  });
});

describe("é o mesmo vídeo?", () => {
  it("formas diferentes do MESMO vídeo não disparam novo download", () => {
    expect(sameVideo(`https://youtu.be/${ID}`, `https://www.youtube.com/watch?v=${ID}`)).toBe(true);
    expect(sameVideo(`https://m.youtube.com/watch?v=${ID}&si=a`, `https://youtu.be/${ID}`)).toBe(
      true,
    );
  });

  it("vídeos diferentes são detectados", () => {
    expect(sameVideo(`https://youtu.be/${ID}`, "https://youtu.be/ZZZZZZZZZZZ")).toBe(false);
  });

  it("Short e vídeo padrão do mesmo id contam como o mesmo vídeo", () => {
    // A capa é a mesma; só a moldura de exibição muda.
    expect(sameVideo(`https://youtu.be/${ID}`, `https://www.youtube.com/shorts/${ID}`)).toBe(true);
  });

  it("ausência de vídeo dos dois lados é 'sem mudança'", () => {
    expect(sameVideo(null, "")).toBe(true);
  });

  it("adicionar ou remover vídeo conta como mudança", () => {
    expect(sameVideo(null, `https://youtu.be/${ID}`)).toBe(false);
    expect(sameVideo(`https://youtu.be/${ID}`, null)).toBe(false);
  });
});
