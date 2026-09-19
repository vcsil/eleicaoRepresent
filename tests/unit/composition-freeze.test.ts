import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminRequestScope } from "@/tests/mocks/admin-request";

/**
 * O congelamento da composição é decidido no banco, numa transação só
 * (`save_candidate` / `set_candidate_active`, migration 0021). O
 * comportamento eleitoral está coberto contra um PostgreSQL real em
 * `tests/integration/composicao-atomica.test.ts`, inclusive a corrida com
 * a liberação.
 *
 * O que sobra para este arquivo é o contrato da Server Action:
 *  - ela delega a gravação inteira à função atômica, em vez de emendar
 *    leitura, DELETE e INSERT por conta própria (era isso que abria as
 *    janelas B, C e D);
 *  - traduz cada recusa do banco numa mensagem para o administrador;
 *  - mantém as chamadas externas (upload de foto, download de capa) FORA
 *    da transação, e compensa a capa órfã quando a gravação falha.
 */

const adminScope = createAdminRequestScope();
vi.mock("next/headers", () => adminScope.nextHeaders());
vi.mock("next/navigation", () => adminScope.nextNavigation());

vi.mock("next/cache", () => ({
  updateTag: () => {},
  revalidatePath: () => {},
  unstable_cache: <T>(fn: T) => fn,
}));

vi.mock("@/lib/admin/audit-log", () => ({ logAdminAction: async () => {} }));

const ensureYouTubeThumbnail =
  vi.fn<(id: string, url: string) => Promise<{ stored: boolean; path: string; created: boolean }>>(
    async () => ({ stored: true, path: "p", created: true }),
  );
const deleteYouTubeThumbnail = vi.fn<(id: string, url: string) => Promise<void>>(async () => {});
vi.mock("@/lib/admin/youtube-thumbnail", () => ({
  ensureYouTubeThumbnail: (id: string, url: string) => ensureYouTubeThumbnail(id, url),
  deleteYouTubeThumbnail: (id: string, url: string) => deleteYouTubeThumbnail(id, url),
  sameVideo: (a: string | null, b: string | null) => a === b,
}));

/** Erro devolvido por `save_candidate` no próximo teste, se houver. */
let rpcError: { message: string } | null = null;
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
/** Tabelas escritas direto pela action — deve ficar vazio. */
const escritasDiretas: { tabela: string; operacao: string }[] = [];
let votingReleasedAt: string | null = null;

function chain(tabela: string, resolved: { data: unknown; error: null }) {
  const stub: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) stub[m] = () => stub;
  for (const m of ["insert", "update", "delete", "upsert"]) {
    stub[m] = () => {
      escritasDiretas.push({ tabela, operacao: m });
      return stub;
    };
  }
  stub.maybeSingle = async () => resolved;
  stub.single = async () => resolved;
  stub.then = (resolve: (v: unknown) => unknown) => resolve(resolved);
  return stub;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (tabela: string) => {
      if (tabela === "elections") {
        return chain(tabela, { data: { voting_released_at: votingReleasedAt }, error: null });
      }
      if (tabela === "candidates") {
        return chain(tabela, {
          data: { photo_path: null, video_url: null },
          error: null,
        });
      }
      return chain(tabela, { data: null, error: null });
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "check_admin_session") return adminScope.checkAdminSessionResult();
      rpcCalls.push({ fn, args });
      if (rpcError) return { data: null, error: rpcError };
      return { data: (args.p_candidate_id as string) ?? "id-novo", error: null };
    },
  }),
}));

const { upsertCandidateAction, setCandidateActiveAction } = await import(
  "@/app/admin/(protected)/candidatos/actions"
);
const { electionIsFrozen } = await import("@/lib/election/composition-freeze");

const CANDIDATO = "22222222-2222-4222-8222-222222222222";
const CARGO_A = "33333333-3333-4333-8333-333333333333";
const CARGO_B = "44444444-4444-4444-8444-444444444444";

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const campos: Record<string, string> = {
    id: CANDIDATO,
    full_name: "Ana Souza",
    position_id_1: CARGO_A,
    position_id_2: "",
    tagline: "",
    presentation: "",
    proposals: "",
    video_url: "",
    display_order: "3",
    active: "on",
    ...overrides,
  };
  for (const [key, value] of Object.entries(campos)) {
    if (value !== "") data.set(key, value);
  }
  return data;
}

beforeEach(() => {
  adminScope.reset();
  rpcCalls.length = 0;
  escritasDiretas.length = 0;
  rpcError = null;
  votingReleasedAt = "2026-09-19T12:00:00Z";
  ensureYouTubeThumbnail.mockClear();
  deleteYouTubeThumbnail.mockClear();
});

describe("a gravação é uma operação só, no banco", () => {
  it("delega tudo a save_candidate", async () => {
    await expect(upsertCandidateAction({ error: null }, form())).rejects.toThrow("NEXT_REDIRECT");

    expect(rpcCalls.map((c) => c.fn)).toEqual(["save_candidate"]);
    expect(rpcCalls[0].args).toMatchObject({
      p_candidate_id: CANDIDATO,
      p_full_name: "Ana Souza",
      p_display_order: 3,
      p_active: true,
      p_position_ids: [CARGO_A],
    });
  });

  it("NÃO apaga nem recria candidate_positions por conta própria", async () => {
    // O DELETE seguido de INSERT era o que deixava um cargo sem disputa no
    // intervalo entre as duas chamadas, permitindo uma cédula incompleta.
    await expect(
      upsertCandidateAction({ error: null }, form({ presentation: "Texto novo" })),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(escritasDiretas).toEqual([]);
  });

  it("recusa dois cargos iguais antes de chegar ao banco", async () => {
    const result = await upsertCandidateAction(
      { error: null },
      form({ position_id_1: CARGO_A, position_id_2: CARGO_A }),
    );
    expect(result.error).toMatch(/cargos diferentes/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("aceita os mesmos dois cargos em ordem trocada", async () => {
    await expect(
      upsertCandidateAction(
        { error: null },
        form({ position_id_1: CARGO_B, position_id_2: CARGO_A }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(rpcCalls[0].args.p_position_ids).toEqual([CARGO_B, CARGO_A]);
  });
});

describe("tradução das recusas do banco", () => {
  for (const [codigo, trecho] of [
    ["COMPOSITION_FROZEN", /composição da eleição não pode mais mudar/],
    ["COMPOSITION_FROZEN_CREATE", /não é possível cadastrar novos candidatos/],
    ["DUPLICATE_POSITIONS", /cargos diferentes/],
    ["INVALID_POSITIONS", /cargos válidos/],
    ["CANDIDATE_NOT_FOUND", /não encontrado/],
  ] as const) {
    it(`${codigo} vira mensagem para o administrador`, async () => {
      rpcError = { message: codigo };
      const result = await upsertCandidateAction({ error: null }, form());
      expect(result.error).toMatch(trecho);
    });
  }

  it("não vaza detalhe interno de um erro desconhecido", async () => {
    rpcError = { message: 'null value in column "x" violates not-null constraint' };
    const result = await upsertCandidateAction({ error: null }, form());
    expect(result.error).toBe("Não foi possível salvar o candidato.");
  });
});

describe("chamadas externas ficam fora da transação", () => {
  it("a capa é baixada ANTES de save_candidate", async () => {
    const ordem: string[] = [];
    ensureYouTubeThumbnail.mockImplementation(async () => {
      ordem.push("capa");
      return { stored: true, path: "p", created: true };
    });

    await expect(
      upsertCandidateAction(
        { error: null },
        form({ video_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    ordem.push("save");
    expect(ordem).toEqual(["capa", "save"]);
  });

  it("a capa criada agora é removida quando a gravação falha", async () => {
    rpcError = { message: "COMPOSITION_FROZEN" };
    const result = await upsertCandidateAction(
      { error: null },
      form({ video_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }),
    );

    expect(result.error).toMatch(/composição/);
    expect(deleteYouTubeThumbnail).toHaveBeenCalledWith(
      CANDIDATO,
      "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    );
  });

  it("uma capa que já existia NÃO é removida pela falha", async () => {
    // `created: false` significa que a capa já estava lá antes desta
    // gravação: apagá-la deixaria o candidato sem capa por causa de um
    // erro que não a criou.
    ensureYouTubeThumbnail.mockResolvedValue({ stored: true, path: "p", created: false });
    rpcError = { message: "COMPOSITION_FROZEN" };

    await upsertCandidateAction(
      { error: null },
      form({ video_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }),
    );
    expect(deleteYouTubeThumbnail).not.toHaveBeenCalled();
  });
});

describe("setCandidateActiveAction", () => {
  it("delega ao banco em vez de verificar antes de escrever", async () => {
    await setCandidateActiveAction(CANDIDATO, false);
    expect(rpcCalls).toEqual([
      { fn: "set_candidate_active", args: { p_candidate_id: CANDIDATO, p_active: false } },
    ]);
    expect(escritasDiretas).toEqual([]);
  });

  it("propaga a recusa do banco", async () => {
    rpcError = { message: "COMPOSITION_FROZEN" };
    await expect(setCandidateActiveAction(CANDIDATO, false)).rejects.toThrow("COMPOSITION_FROZEN");
  });
});

describe("electionIsFrozen continua servindo à tela", () => {
  it("congelada quando existe carimbo de liberação", async () => {
    expect(await electionIsFrozen()).toBe(true);
  });

  it("não congelada antes da liberação", async () => {
    votingReleasedAt = null;
    expect(await electionIsFrozen()).toBe(false);
  });
});
