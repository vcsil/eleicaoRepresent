import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminRequestScope } from "@/tests/mocks/admin-request";

/**
 * Depois que a votação é liberada, a composição da eleição não muda mais.
 *
 * O que estes testes protegem não é a tela — é a RECUSA no servidor. Um
 * campo escondido no formulário não impede um POST montado à mão, e mudar
 * um candidato depois da abertura da urna muda a cédula debaixo de quem já
 * votou (e pode até fazer um cargo inteiro entrar ou sair dela, porque
 * cargo sem disputa não vai à urna).
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
vi.mock("@/lib/admin/youtube-thumbnail", () => ({
  ensureYouTubeThumbnail: async () => ({ stored: false, reason: "sem-video" }),
  deleteYouTubeThumbnail: async () => {},
  sameVideo: () => true,
}));

/** Estado do banco simulado, reescrito por cada teste. */
let votingReleasedAt: string | null = null;
/** Quando verdadeiro, a leitura de `elections` falha. */
let leituraDaEleicaoFalha = false;
let candidatoAtual: Record<string, unknown> | null = null;
const updates: Record<string, unknown>[] = [];

function chain(resolved: { data: unknown; error: null }) {
  const stub: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "insert", "delete"]) {
    stub[method] = () => stub;
  }
  stub.update = (payload: Record<string, unknown>) => {
    updates.push(payload);
    return stub;
  };
  stub.maybeSingle = async () => resolved;
  stub.single = async () => resolved;
  stub.then = (resolve: (v: unknown) => unknown) => resolve(resolved);
  return stub;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === "elections") {
        return leituraDaEleicaoFalha
          ? chain({ data: null, error: { message: "boom" } as unknown as null })
          : chain({ data: { voting_released_at: votingReleasedAt }, error: null });
      }
      if (table === "candidates") {
        return chain({ data: candidatoAtual, error: null });
      }
      return chain({ data: null, error: null });
    },
    rpc: async (fn: string) =>
      fn === "check_admin_session"
        ? adminScope.checkAdminSessionResult()
        : { data: null, error: null },
  }),
}));

const { upsertCandidateAction, setCandidateActiveAction } = await import(
  "@/app/admin/(protected)/candidatos/actions"
);
const { electionIsFrozen } = await import("@/lib/election/composition-freeze");

const CANDIDATO = "22222222-2222-4222-8222-222222222222";
const CARGO_A = "33333333-3333-4333-8333-333333333333";
const CARGO_B = "44444444-4444-4444-8444-444444444444";

/** Formulário completo, como o navegador enviaria. */
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
  updates.length = 0;
  leituraDaEleicaoFalha = false;
  votingReleasedAt = "2026-09-19T12:00:00Z";
  candidatoAtual = {
    full_name: "Ana Souza",
    active: true,
    display_order: 3,
    candidate_positions: [{ position_id: CARGO_A }],
    photo_path: null,
    video_url: null,
  };
});

describe("electionIsFrozen", () => {
  it("não congelada enquanto a votação não foi liberada", async () => {
    votingReleasedAt = null;
    expect(await electionIsFrozen()).toBe(false);
  });

  it("congelada assim que existe carimbo de liberação", async () => {
    expect(await electionIsFrozen()).toBe(true);
  });

  it("falha de leitura CONGELA — nunca libera a edição por não saber", async () => {
    // Fail-closed de propósito: se o banco não responde, a resposta segura
    // é recusar a alteração, não permitir uma mudança de composição no meio
    // de uma votação em andamento.
    leituraDaEleicaoFalha = true;
    votingReleasedAt = null;
    expect(await electionIsFrozen()).toBe(true);
  });

  it("uma falha de leitura bloqueia a Server Action", async () => {
    leituraDaEleicaoFalha = true;
    await expect(setCandidateActiveAction(CANDIDATO, false)).rejects.toThrow("COMPOSITION_FROZEN");
    expect(updates).toHaveLength(0);
  });
});

describe("upsertCandidateAction com a composição congelada", () => {
  it("recusa trocar o nome", async () => {
    const result = await upsertCandidateAction(
      { error: null },
      form({ full_name: "Ana Souza Lima" }),
    );
    expect(result.error).toMatch(/composição da eleição não pode mais mudar/);
    expect(updates).toHaveLength(0);
  });

  it("recusa trocar o cargo", async () => {
    const result = await upsertCandidateAction({ error: null }, form({ position_id_1: CARGO_B }));
    expect(result.error).toMatch(/composição da eleição não pode mais mudar/);
    expect(updates).toHaveLength(0);
  });

  it("recusa acrescentar um segundo cargo", async () => {
    const result = await upsertCandidateAction({ error: null }, form({ position_id_2: CARGO_B }));
    expect(result.error).toMatch(/composição da eleição não pode mais mudar/);
    expect(updates).toHaveLength(0);
  });

  it("recusa REMOVER um dos dois cargos", async () => {
    // O candidato tem dois cargos e o formulário devolve só um: uma
    // comparação que só olhasse "todo cargo enviado já existia" deixaria
    // isso passar, e o segundo cargo seria apagado.
    candidatoAtual = {
      full_name: "Ana Souza",
      active: true,
      display_order: 3,
      candidate_positions: [{ position_id: CARGO_A }, { position_id: CARGO_B }],
      photo_path: null,
      video_url: null,
    };
    const result = await upsertCandidateAction({ error: null }, form());
    expect(result.error).toMatch(/composição da eleição não pode mais mudar/);
    expect(updates).toHaveLength(0);
  });

  it("recusa trocar a ordem de exibição", async () => {
    const result = await upsertCandidateAction({ error: null }, form({ display_order: "9" }));
    expect(result.error).toMatch(/composição da eleição não pode mais mudar/);
    expect(updates).toHaveLength(0);
  });

  it("recusa inativar pelo formulário", async () => {
    const data = form();
    data.delete("active");
    const result = await upsertCandidateAction({ error: null }, data);
    expect(result.error).toMatch(/composição da eleição não pode mais mudar/);
    expect(updates).toHaveLength(0);
  });

  it("recusa cadastrar um candidato novo", async () => {
    const data = form();
    data.delete("id");
    const result = await upsertCandidateAction({ error: null }, data);
    expect(result.error).toMatch(/não é possível cadastrar novos candidatos/);
    expect(updates).toHaveLength(0);
  });

  it("ACEITA editar os campos informativos, preservando a composição", async () => {
    // O caminho de sucesso termina em `redirect()`, que lança: chegar até
    // ele já significa que a guarda NÃO recusou.
    await expect(
      upsertCandidateAction(
        { error: null },
        form({
          tagline: "Pela turma",
          presentation: "Apresentação nova",
          proposals: "Propostas novas",
          video_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
        }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(updates.at(0)).toMatchObject({
      tagline: "Pela turma",
      presentation: "Apresentação nova",
      proposals: "Propostas novas",
      full_name: "Ana Souza",
      display_order: 3,
      active: true,
    });
  });

  it("com a votação ainda não liberada, trocar nome e cargo é permitido", async () => {
    votingReleasedAt = null;
    await expect(
      upsertCandidateAction(
        { error: null },
        form({ full_name: "Outro Nome", position_id_1: CARGO_B }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(updates.at(0)).toMatchObject({ full_name: "Outro Nome" });
  });
});

describe("setCandidateActiveAction com a composição congelada", () => {
  it("recusa inativar", async () => {
    await expect(setCandidateActiveAction(CANDIDATO, false)).rejects.toThrow("COMPOSITION_FROZEN");
    expect(updates).toHaveLength(0);
  });

  it("recusa reativar", async () => {
    await expect(setCandidateActiveAction(CANDIDATO, true)).rejects.toThrow("COMPOSITION_FROZEN");
    expect(updates).toHaveLength(0);
  });

  it("permite antes da liberação", async () => {
    votingReleasedAt = null;
    await setCandidateActiveAction(CANDIDATO, false);
    expect(updates).toContainEqual({ active: false });
  });
});
