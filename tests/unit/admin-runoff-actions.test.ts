import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminRequestScope } from "@/tests/mocks/admin-request";

/**
 * As ações administrativas do ciclo do desempate precisam operar sobre o ID
 * DO DESEMPATE. O risco concreto é encerrar/apurar/publicar a eleição geral
 * por engano — as mesmas actions servem aos dois, e só o id distingue.
 */
const MAIN = "11111111-1111-4111-8111-111111111111";
const RUNOFF = "22222222-2222-4222-8222-222222222222";

const adminScope = createAdminRequestScope();
vi.mock("next/headers", () => adminScope.nextHeaders());
vi.mock("next/navigation", () => adminScope.nextNavigation());

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

/** Registra tudo que as actions mandam para o banco. */
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
const tableWrites: { table: string; op: string; filters: Record<string, unknown> }[] = [];

function createQueryStub(table: string) {
  const write = { table, op: "select", filters: {} as Record<string, unknown> };
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "insert", "delete", "is", "in", "maybeSingle", "order"]) {
    chain[method] = () => chain;
  }
  chain.update = () => {
    write.op = "update";
    tableWrites.push(write);
    return chain;
  };
  chain.eq = (column: string, value: unknown) => {
    write.filters[column] = value;
    return chain;
  };
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
  return chain;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => createQueryStub(table),
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (fn === "check_admin_session") return adminScope.checkAdminSessionResult();
      rpcCalls.push({ fn, args });
      return { data: null, error: null };
    },
  }),
}));

const adminLogs: { action: string; details: unknown }[] = [];
vi.mock("@/lib/admin/audit-log", () => ({
  logAdminAction: async (action: string, details: unknown) => void adminLogs.push({ action, details }),
}));

const { publishResultsAction } = await import("@/app/admin/(protected)/resultados/actions");
const { closeVotingAction, computeResultsAction } = await import(
  "@/app/admin/(protected)/votacao/actions"
);

function form(electionId: string) {
  const data = new FormData();
  data.set("election_id", electionId);
  return data;
}

beforeEach(() => {
  rpcCalls.length = 0;
  tableWrites.length = 0;
  adminLogs.length = 0;
  adminScope.reset();
});

describe("encerrar a votação do desempate", () => {
  it("encerra o desempate, e não a eleição geral", async () => {
    const result = await closeVotingAction({ error: null }, form(RUNOFF));
    expect(result.error).toBeNull();

    const update = tableWrites.find((w) => w.table === "elections" && w.op === "update");
    expect(update?.filters.id).toBe(RUNOFF);
    expect(update?.filters.id).not.toBe(MAIN);
  });

  it("registra o encerramento no log administrativo com o id do desempate", async () => {
    await closeVotingAction({ error: null }, form(RUNOFF));
    expect(adminLogs).toContainEqual({
      action: "VOTING_CLOSED_MANUALLY",
      details: { electionId: RUNOFF },
    });
  });

  it("continua encerrando a eleição geral normalmente", async () => {
    await closeVotingAction({ error: null }, form(MAIN));
    const update = tableWrites.find((w) => w.table === "elections" && w.op === "update");
    expect(update?.filters.id).toBe(MAIN);
  });
});

describe("apuração do desempate", () => {
  it("apura o desempate pelo id dele", async () => {
    await computeResultsAction({ error: null }, form(RUNOFF));
    expect(rpcCalls).toContainEqual({ fn: "compute_results", args: { p_election_id: RUNOFF } });
    expect(rpcCalls.every((c) => c.args.p_election_id !== MAIN)).toBe(true);
  });
});

describe("publicação do desempate", () => {
  it("publica o desempate pelo id dele", async () => {
    await publishResultsAction({ error: null }, form(RUNOFF));
    expect(rpcCalls).toContainEqual({ fn: "publish_results", args: { p_election_id: RUNOFF } });
  });

  it("NÃO publica a eleição principal junto", async () => {
    await publishResultsAction({ error: null }, form(RUNOFF));
    const publicacoes = rpcCalls.filter((c) => c.fn === "publish_results");
    expect(publicacoes).toHaveLength(1);
    expect(publicacoes[0].args.p_election_id).toBe(RUNOFF);
  });

  it("não resolve o empate do pai pelo TypeScript — isso é do Postgres", async () => {
    await publishResultsAction({ error: null }, form(RUNOFF));
    // publish_results(runoff) já chama resolve_parent_ties_from_runoff na
    // mesma transação (migration 0014). Se a aplicação chamasse essa função
    // por fora, ou escrevesse em result_snapshots, a resolução deixaria de
    // ser atômica com a publicação.
    expect(rpcCalls.map((c) => c.fn)).not.toContain("resolve_parent_ties_from_runoff");
    expect(tableWrites.filter((w) => w.table === "result_snapshots")).toHaveLength(0);
  });
});

describe("guarda de sessão nas ações do desempate", () => {
  it("nenhuma delas toca o banco sem sessão administrativa", async () => {
    vi.resetModules();
    const semSessao = createAdminRequestScope({ authenticated: false });
    vi.doMock("next/headers", () => semSessao.nextHeaders());
    vi.doMock("next/navigation", () => semSessao.nextNavigation());

    const votacao = await import("@/app/admin/(protected)/votacao/actions");
    const resultados = await import("@/app/admin/(protected)/resultados/actions");

    for (const action of [
      votacao.closeVotingAction,
      votacao.computeResultsAction,
      resultados.publishResultsAction,
    ]) {
      await expect(action({ error: null }, form(RUNOFF))).rejects.toThrow("NEXT_REDIRECT");
    }
    expect(rpcCalls).toHaveLength(0);
    expect(tableWrites).toHaveLength(0);
    vi.doUnmock("next/headers");
    vi.doUnmock("next/navigation");
  });
});
