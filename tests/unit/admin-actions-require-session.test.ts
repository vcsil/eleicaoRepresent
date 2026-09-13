import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminRequestScope } from "@/tests/mocks/admin-request";

/**
 * Toda Server Action administrativa precisa exigir sessão.
 *
 * Server Actions são endpoints HTTP: sem a guarda, qualquer pessoa que
 * descubra o identificador da action consegue invocá-la sem estar logada —
 * encerrar a votação, publicar resultados, importar eleitores.
 *
 * A PR do logout por inatividade acrescentou `requireAdminSession()` a
 * todas elas, mas nada verificava isso. Este arquivo é essa verificação: se
 * alguém remover a guarda de uma action, o teste correspondente falha.
 *
 * O escopo é criado SEM sessão — `requireAdminSession` então redireciona
 * para /admin, e o `redirect()` do Next lança para interromper a execução.
 */
const adminScope = createAdminRequestScope({ authenticated: false });
vi.mock("next/headers", () => adminScope.nextHeaders());
vi.mock("next/navigation", () => adminScope.nextNavigation());

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

/** Query builder encadeável que sempre resolve sem erro. */
function createQueryStub() {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "update", "insert", "delete", "eq", "is", "in", "maybeSingle", "order"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
  return chain;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => createQueryStub(),
    rpc: async (fn: string) =>
      fn === "check_admin_session" ? adminScope.checkAdminSessionResult() : { data: null, error: null },
  }),
}));

vi.mock("@/lib/admin/audit-log", () => ({ logAdminAction: async () => {} }));
vi.mock("@/lib/election/status", () => ({
  getMainElection: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
  getElectionStatus: async () => "votacao_encerrada",
  isVotingOpen: () => false,
}));

const ELECTION_ID = "11111111-1111-4111-8111-111111111111";

const { setCandidateActiveAction } = await import("@/app/admin/(protected)/candidatos/actions");
const { updatePhaseAction } = await import("@/app/admin/(protected)/cronograma/actions");
const { publishResultsAction } = await import("@/app/admin/(protected)/resultados/actions");
const { closeVotingAction, computeResultsAction } = await import(
  "@/app/admin/(protected)/votacao/actions"
);
const { createRunoffAction, resolveDualWinnerAction } = await import(
  "@/app/admin/(protected)/desempates/actions"
);
const { invalidateAllCachesAction } = await import("@/app/admin/(protected)/dashboard/actions");
const { importVotersAction } = await import("@/app/admin/(protected)/eleitores/actions");

function electionForm(): FormData {
  const formData = new FormData();
  formData.set("election_id", ELECTION_ID);
  return formData;
}

beforeEach(() => {
  adminScope.reset();
});

describe("Server Actions administrativas exigem sessão", () => {
  const casos: [string, () => Promise<unknown>][] = [
    ["ativar/desativar candidato", () => setCandidateActiveAction(ELECTION_ID, false)],
    ["alterar cronograma", () => updatePhaseAction({ error: null }, electionForm())],
    ["publicar resultados", () => publishResultsAction({ error: null }, electionForm())],
    ["encerrar votação", () => closeVotingAction({ error: null }, electionForm())],
    ["apurar resultados", () => computeResultsAction({ error: null }, electionForm())],
    ["criar desempate", () => createRunoffAction({ error: null }, electionForm())],
    ["resolver cargo duplo", () => resolveDualWinnerAction({ error: null }, electionForm())],
    ["invalidar cache", () => invalidateAllCachesAction()],
    ["importar eleitores", () => importVotersAction({ error: null }, new FormData())],
  ];

  for (const [nome, executar] of casos) {
    it(`${nome} — sem sessão, redireciona para /admin`, async () => {
      await expect(executar()).rejects.toThrow("NEXT_REDIRECT");
      expect(adminScope.redirect).toHaveBeenCalledWith("/admin?reason=expired");
    });
  }

  it("nenhuma action grava dados quando a sessão está ausente", async () => {
    // A guarda roda ANTES de qualquer escrita — o redirect interrompe a
    // execução, então nenhum cookie é tocado no caminho não autenticado.
    await expect(closeVotingAction({ error: null }, electionForm())).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(adminScope.cookieSet).not.toHaveBeenCalled();
  });
});
