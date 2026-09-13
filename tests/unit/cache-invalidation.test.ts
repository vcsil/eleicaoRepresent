import { beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { createAdminRequestScope } from "@/tests/mocks/admin-request";

/**
 * Garante que toda mutação administrativa invalida as tags certas do Data
 * Cache. Os leitores públicos usam `revalidate: false` — se uma action
 * esquecer de invalidar, o dado fica servido do cache indefinidamente
 * (candidato desativado continuaria aparecendo na urna, cronograma
 * alterado não apareceria na home, etc.). Este teste é a rede de
 * segurança contra esse esquecimento.
 */

const updateTag = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({
  updateTag: (tag: string) => updateTag(tag),
  revalidatePath: (path: string) => revalidatePath(path),
  unstable_cache: <T>(fn: T) => fn,
}));

/**
 * Escopo de requisição administrativa: as actions abaixo começam com
 * `requireAdminSession()`, que lê cookie. Sem isto, todas falham com
 * "cookies was called outside a request scope" — e a guarda continua sendo
 * executada de verdade, só com uma sessão válida simulada.
 */
const adminScope = createAdminRequestScope();
vi.mock("next/headers", () => adminScope.nextHeaders());
vi.mock("next/navigation", () => adminScope.nextNavigation());

/** Query builder encadeável que sempre resolve sem erro. */
function createQueryStub() {
  const result = { data: null, error: null };
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "update", "insert", "delete", "eq", "is", "maybeSingle"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return chain;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => createQueryStub(),
    rpc: async (fn: string) =>
      fn === "check_admin_session"
        ? adminScope.checkAdminSessionResult()
        : { data: null, error: null },
  }),
}));

vi.mock("@/lib/admin/audit-log", () => ({
  logAdminAction: async () => {},
}));

const { setCandidateActiveAction } = await import("@/app/admin/(protected)/candidatos/actions");
const { updatePhaseAction } = await import("@/app/admin/(protected)/cronograma/actions");
const { publishResultsAction } = await import("@/app/admin/(protected)/resultados/actions");
const { closeVotingAction, computeResultsAction } = await import(
  "@/app/admin/(protected)/votacao/actions"
);
const { invalidateAllCachesAction } = await import(
  "@/app/admin/(protected)/dashboard/actions"
);

const ELECTION_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  updateTag.mockClear();
  revalidatePath.mockClear();
  adminScope.reset();
});

function invalidatedTags(): string[] {
  return updateTag.mock.calls.map((call) => call[0] as string);
}

describe("invalidação de cache nas actions administrativas", () => {
  it("desativar candidato invalida candidatos E opções da urna", async () => {
    await setCandidateActiveAction("22222222-2222-4222-8222-222222222222", false);
    expect(invalidatedTags()).toContain(CACHE_TAGS.candidates);
    expect(invalidatedTags()).toContain(CACHE_TAGS.ballotOptions);
  });

  it("reativar candidato também invalida as duas tags", async () => {
    await setCandidateActiveAction("22222222-2222-4222-8222-222222222222", true);
    expect(invalidatedTags()).toContain(CACHE_TAGS.candidates);
    expect(invalidatedTags()).toContain(CACHE_TAGS.ballotOptions);
  });

  it("alterar cronograma invalida fases e eleição pública", async () => {
    const formData = new FormData();
    formData.set("election_id", ELECTION_ID);
    formData.set("phase_key", "votacao");
    formData.set("starts_on", "2026-09-19");
    formData.set("ends_on", "2026-09-23");
    formData.set("start_time", "08:00");
    formData.set("end_time", "18:00");

    const result = await updatePhaseAction({ error: null }, formData);

    expect(result.error).toBeNull();
    expect(invalidatedTags()).toContain(CACHE_TAGS.electionPhases);
    expect(invalidatedTags()).toContain(CACHE_TAGS.publicElection);
  });

  it("publicar resultados invalida resultados publicados e eleição pública", async () => {
    const formData = new FormData();
    formData.set("election_id", ELECTION_ID);

    await publishResultsAction({ error: null }, formData);

    expect(invalidatedTags()).toContain(CACHE_TAGS.publishedResults);
    expect(invalidatedTags()).toContain(CACHE_TAGS.publicElection);
  });

  it("encerrar votação invalida a eleição pública", async () => {
    const formData = new FormData();
    formData.set("election_id", ELECTION_ID);

    await closeVotingAction({ error: null }, formData);

    expect(invalidatedTags()).toContain(CACHE_TAGS.publicElection);
  });

  it("apurar resultados invalida a eleição pública", async () => {
    const formData = new FormData();
    formData.set("election_id", ELECTION_ID);

    await computeResultsAction({ error: null }, formData);

    expect(invalidatedTags()).toContain(CACHE_TAGS.publicElection);
  });

  it("não invalida nada quando o payload do cronograma é inválido", async () => {
    const formData = new FormData();
    formData.set("election_id", ELECTION_ID);
    formData.set("phase_key", "fase_inexistente");

    const result = await updatePhaseAction({ error: null }, formData);

    expect(result.error).not.toBeNull();
    expect(invalidatedTags()).toHaveLength(0);
  });
});

describe("invalidação manual pelo painel", () => {
  it("cobre TODAS as tags — uma tag nova não pode ficar de fora", async () => {
    const result = await invalidateAllCachesAction();

    expect(result.error).toBeNull();
    // Comparação por conjunto contra CACHE_TAGS: se alguém adicionar uma
    // tag nova e a action não a invalidar, este teste quebra. É o ponto
    // do botão — ele é o escape para alterações feitas direto no banco,
    // e um escape parcial não serve.
    expect(new Set(invalidatedTags())).toEqual(new Set(Object.values(CACHE_TAGS)));
  });
});

describe("CACHE_TAGS", () => {
  it("não tem tags duplicadas (uma tag colidida invalidaria o cache errado)", () => {
    const values = Object.values(CACHE_TAGS);
    expect(new Set(values).size).toBe(values.length);
  });
});
