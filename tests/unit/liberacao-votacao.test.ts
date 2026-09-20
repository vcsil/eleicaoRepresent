import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SESSION_COOKIE, createAdminRequestScope } from "@/tests/mocks/admin-request";

/**
 * Liberação manual da votação: a Server Action e o que a tela promete.
 */

const adminScope = createAdminRequestScope();
vi.mock("next/headers", () => adminScope.nextHeaders());
vi.mock("next/navigation", () => adminScope.nextNavigation());

const updateTag = vi.fn();
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  updateTag: (tag: string) => updateTag(tag),
  revalidatePath: (path: string) => revalidatePath(path),
  unstable_cache: <T>(fn: T) => fn,
}));

const logAdminAction = vi.fn<(action: string, meta: unknown) => Promise<void>>();
vi.mock("@/lib/admin/audit-log", () => ({
  logAdminAction: async (action: string, meta: unknown) => {
    await logAdminAction(action, meta);
  },
}));

/** Erro devolvido por `release_voting` no próximo teste, se houver. */
let rpcError: { message: string } | null = null;
const rpcCalls: [string, unknown][] = [];

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => {
      const stub: Record<string, unknown> = {};
      for (const m of ["select", "update", "insert", "eq", "is", "order", "limit"]) {
        stub[m] = () => stub;
      }
      stub.maybeSingle = async () => ({ data: null, error: null });
      stub.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return stub;
    },
    rpc: async (fn: string, args: unknown) => {
      if (fn === "check_admin_session") return adminScope.checkAdminSessionResult();
      rpcCalls.push([fn, args]);
      return { data: null, error: rpcError };
    },
  }),
}));

const { releaseVotingAction } = await import("@/app/admin/(protected)/votacao/actions");

const ELECTION_ID = "11111111-1111-4111-8111-111111111111";

function form(digest?: string): FormData {
  const data = new FormData();
  data.set("election_id", ELECTION_ID);
  if (digest !== undefined) data.set("composition_digest", digest);
  return data;
}

beforeEach(() => {
  adminScope.reset();
  updateTag.mockClear();
  revalidatePath.mockClear();
  logAdminAction.mockClear();
  rpcCalls.length = 0;
  rpcError = null;
});

describe("releaseVotingAction", () => {
  it("chama release_voting no banco — a decisão não é do TypeScript", async () => {
    const result = await releaseVotingAction({ error: null }, form());
    expect(result.error).toBeNull();
    expect(rpcCalls).toEqual([
      ["release_voting", { p_election_id: ELECTION_ID, p_expected_digest: null }],
    ]);
  });

  it("repassa ao banco a digital da composição que o resumo descreveu", async () => {
    // O banco confere a digital com a linha da eleição já travada: é o que
    // impede liberar uma composição diferente da que foi revisada.
    await releaseVotingAction({ error: null }, form("abc123"));
    expect(rpcCalls[0][1]).toEqual({
      p_election_id: ELECTION_ID,
      p_expected_digest: "abc123",
    });
  });

  it("traduz COMPOSITION_CHANGED pedindo nova revisão", async () => {
    rpcError = { message: "COMPOSITION_CHANGED" };
    const result = await releaseVotingAction({ error: null }, form("abc123"));
    expect(result.error).toMatch(/mudou desde que este resumo foi carregado/);
  });

  it("traduz VOTING_WINDOW_ENDED apontando o cronograma", async () => {
    rpcError = { message: "VOTING_WINDOW_ENDED" };
    const result = await releaseVotingAction({ error: null }, form());
    expect(result.error).toMatch(/período de votação do cronograma já terminou/);
  });

  it("exige sessão administrativa", async () => {
    // Sem o cookie, `requireAdminSession()` redireciona antes de qualquer
    // coisa — e o banco nunca é tocado.
    const cookie = adminScope.cookies.get(ADMIN_SESSION_COOKIE)!;
    adminScope.cookies.delete(ADMIN_SESSION_COOKIE);
    try {
      await expect(releaseVotingAction({ error: null }, form())).rejects.toThrow("NEXT_REDIRECT");
      expect(rpcCalls).toHaveLength(0);
    } finally {
      adminScope.cookies.set(ADMIN_SESSION_COOKIE, cookie);
    }
  });

  it("recusa um election_id ausente sem tocar no banco", async () => {
    const result = await releaseVotingAction({ error: null }, new FormData());
    expect(result.error).toMatch(/Eleição inválida/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("registra a liberação no log administrativo", async () => {
    await releaseVotingAction({ error: null }, form());
    expect(logAdminAction).toHaveBeenCalledWith("VOTING_RELEASED", { electionId: ELECTION_ID });
  });

  it("invalida o cache da eleição pública (o status muda com a liberação)", async () => {
    await releaseVotingAction({ error: null }, form());
    expect(updateTag).toHaveBeenCalledWith("public-election");
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["/", "/votar", "/admin/votacao"]),
    );
  });

  for (const [codigo, trecho] of [
    ["VOTING_NOT_STARTED", /ainda não começou/],
    ["VOTING_WINDOW_NOT_CONFIGURED", /Configure as datas/],
    ["VOTING_ALREADY_CLOSED", /já foi encerrada/],
  ] as const) {
    it(`traduz ${codigo} numa mensagem para o administrador`, async () => {
      rpcError = { message: codigo };
      const result = await releaseVotingAction({ error: null }, form());
      expect(result.error).toMatch(trecho);
    });
  }

  it("não vaza detalhe interno de um erro desconhecido", async () => {
    rpcError = { message: 'duplicate key value violates unique constraint "elections_pkey"' };
    const result = await releaseVotingAction({ error: null }, form());
    expect(result.error).toBe("Não foi possível liberar a votação.");
  });

  it("nada é registrado no log quando o banco recusa", async () => {
    rpcError = { message: "VOTING_NOT_STARTED" };
    await releaseVotingAction({ error: null }, form());
    expect(logAdminAction).not.toHaveBeenCalled();
    expect(updateTag).not.toHaveBeenCalled();
  });
});

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const painel = read("components/admin/ReleaseVotingPanel.tsx");
const pagina = read("app/admin/(protected)/votacao/page.tsx");
const actions = read("app/admin/(protected)/votacao/actions.ts");

describe("o painel de liberação avisa o que a ação implica", () => {
  it("diz que é irreversível", () => {
    expect(painel).toMatch(/irrevers[íi]vel/i);
  });

  it("avisa que a composição congela e lista o que continua editável", () => {
    expect(painel).toMatch(/congela a composição/);
    for (const campo of ["Foto", "apresentação", "propostas", "vídeo"]) {
      expect(painel).toContain(campo);
    }
  });

  it("separa os cargos que votam dos que são decididos na apuração", () => {
    expect(painel).toContain("Cargos que irão à urna");
    expect(painel).toContain("Cargos decididos sem votação");
  });

  it("sinaliza o cargo de assentos nomeados, que vota mesmo sem concorrência", () => {
    // É a diferença que o edital introduz: Tesouraria e Secretaria vão à
    // urna para definir Primeiro e Segundo, não para decidir quem entra.
    expect(painel).toContain("orderedSeats");
    expect(painel).toMatch(/Assentos nomeados/);
  });

  it("explica o que acontece quando nenhum cargo vai à urna", () => {
    expect(painel).toMatch(/Nenhum cargo vai à urna/);
  });

  it("não existe ação de desfazer a liberação", () => {
    expect(actions).not.toMatch(/voting_released_at:\s*null/);
    expect(actions).not.toMatch(/unreleaseVoting|cancelRelease/i);
  });
});

describe("a página de votação decide pelo estado do banco", () => {
  it("lê voting_released_at da eleição, não do relógio do navegador", () => {
    expect(pagina).toContain("election.voting_released_at !== null");
  });

  it("só oferece liberar enquanto a votação está pendente", () => {
    expect(pagina).toContain('status === "aguardando_votacao"');
  });

  it("monta o resumo no servidor, pela definição do banco", () => {
    expect(pagina).toContain("getCompositionPreview()");
  });
});
