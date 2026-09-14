import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminRequestScope } from "@/tests/mocks/admin-request";

/**
 * Exclusão e inativação de eleitor.
 *
 * O foco é a REGRA, não o SQL: quem já votou nunca é excluído, o histórico
 * nunca é tocado para "liberar" a exclusão, e votação aberta exige
 * confirmação revalidada no servidor.
 */
const VOTER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const adminScope = createAdminRequestScope();
vi.mock("next/headers", () => adminScope.nextHeaders());
vi.mock("next/navigation", () => adminScope.nextNavigation());

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
  updateTag: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

type Estado = {
  voterExiste: boolean;
  auditLinks: number;
  deleteError: { code?: string; message: string } | null;
};
let estado: Estado;
const operacoes: { tabela: string; op: string }[] = [];

function builder(tabela: string) {
  const api: Record<string, unknown> = {};
  const chain = () => api;
  for (const m of ["select", "eq", "in", "is", "order"]) api[m] = chain;

  api.delete = () => {
    operacoes.push({ tabela, op: "delete" });
    return {
      eq: async () => ({ error: estado.deleteError, data: null }),
    };
  };
  api.update = (patch: Record<string, unknown>) => {
    operacoes.push({ tabela, op: `update:${JSON.stringify(patch)}` });
    return {
      eq: () => ({
        select: () => ({
          maybeSingle: async () => ({ data: { registration_number: "20260001" }, error: null }),
        }),
      }),
    };
  };
  api.maybeSingle = async () =>
    tabela === "voters"
      ? { data: estado.voterExiste ? { id: VOTER, registration_number: "20260001" } : null, error: null }
      : { data: null, error: null };
  api.then = (resolve: (v: unknown) => unknown) =>
    resolve(
      tabela === "audit_vote_links"
        ? { data: null, count: estado.auditLinks, error: null }
        : { data: [], count: 0, error: null },
    );
  return api;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (tabela: string) => builder(tabela),
    rpc: async (fn: string) =>
      fn === "check_admin_session" ? adminScope.checkAdminSessionResult() : { data: null, error: null },
  }),
}));

const logs: { action: string; details: Record<string, unknown> }[] = [];
vi.mock("@/lib/admin/audit-log", () => ({
  logAdminAction: async (action: string, details: Record<string, unknown>) =>
    void logs.push({ action, details }),
}));

let votingOpen = false;
vi.mock("@/lib/election/status", () => ({
  getMainElection: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
  getElectionStatus: async () => (votingOpen ? "votacao_em_andamento" : "votacao_encerrada"),
  isVotingOpen: (s: string) => s === "votacao_em_andamento" || s === "votacao_desempate",
}));

const { deleteVoterAction, setVoterActiveAction } = await import(
  "@/app/admin/(protected)/eleitores/actions"
);

function form(extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("voter_id", VOTER);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  estado = { voterExiste: true, auditLinks: 0, deleteError: null };
  operacoes.length = 0;
  logs.length = 0;
  revalidatePath.mockClear();
  votingOpen = false;
  adminScope.reset();
});

describe("excluir eleitor que nunca votou", () => {
  it("exclui e registra no log administrativo", async () => {
    const r = await deleteVoterAction({ error: null }, form());
    expect(r.error).toBeNull();
    expect(operacoes).toContainEqual({ tabela: "voters", op: "delete" });
    expect(logs[0]).toMatchObject({
      action: "VOTER_DELETED",
      details: { voterId: VOTER, registration_number: "20260001", during_open_voting: false },
    });
  });

  it("não guarda o nome completo no log", async () => {
    await deleteVoterAction({ error: null }, form());
    expect(JSON.stringify(logs[0].details)).not.toMatch(/full_name|Maria|Silva/);
  });

  it("revalida a lista e o painel", async () => {
    await deleteVoterAction({ error: null }, form());
    expect(revalidatePath).toHaveBeenCalledWith("/admin/eleitores");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/dashboard");
  });
});

describe("excluir eleitor que já votou", () => {
  it("é recusado, com mensagem que aponta a saída real", async () => {
    estado.auditLinks = 1;
    const r = await deleteVoterAction({ error: null }, form());
    expect(r.error).toMatch(/participação eleitoral registrada/);
    expect(r.error).toMatch(/[Ii]native o cadastro/);
  });

  it("NÃO chega a emitir DELETE em tabela nenhuma", async () => {
    estado.auditLinks = 1;
    await deleteVoterAction({ error: null }, form());
    expect(operacoes.filter((o) => o.op === "delete")).toHaveLength(0);
  });

  it("nunca apaga ballots, ballot_choices ou audit_vote_links", async () => {
    estado.auditLinks = 3;
    await deleteVoterAction({ error: null }, form());
    for (const tabela of ["ballots", "ballot_choices", "audit_vote_links"]) {
      expect(operacoes.filter((o) => o.tabela === tabela && o.op === "delete"), tabela).toHaveLength(0);
    }
  });

  it("não registra exclusão no log", async () => {
    estado.auditLinks = 1;
    await deleteVoterAction({ error: null }, form());
    expect(logs.map((l) => l.action)).not.toContain("VOTER_DELETED");
  });

  it("a violação de FK do banco também vira mensagem amigável", async () => {
    // Corrida: o eleitor vota entre a checagem e o DELETE.
    estado.auditLinks = 0;
    estado.deleteError = { code: "23503", message: "foreign key violation" };
    const r = await deleteVoterAction({ error: null }, form());
    expect(r.error).toMatch(/participação eleitoral registrada/);
  });
});

describe("dupla submissão", () => {
  it("a segunda exclusão não quebra nem gera erro", async () => {
    estado.voterExiste = false;
    const r = await deleteVoterAction({ error: null }, form());
    expect(r.error).toBeNull();
    expect(operacoes.filter((o) => o.op === "delete")).toHaveLength(0);
  });
});

describe("votação aberta", () => {
  it("recusa a exclusão sem confirmação extra", async () => {
    votingOpen = true;
    const r = await deleteVoterAction({ error: null }, form());
    expect(r.error).toMatch(/votação está aberta/i);
    expect(operacoes.filter((o) => o.op === "delete")).toHaveLength(0);
  });

  it("permite com confirmação explícita e marca isso no log", async () => {
    votingOpen = true;
    const r = await deleteVoterAction({ error: null }, form({ confirm_voting_open: "1" }));
    expect(r.error).toBeNull();
    expect(logs[0].details.during_open_voting).toBe(true);
  });

  it("a confirmação é revalidada no servidor, não só na tela", async () => {
    // A tela pode mandar qualquer coisa; sem o campo, o servidor recusa.
    votingOpen = true;
    expect((await deleteVoterAction({ error: null }, form({ confirm_voting_open: "0" }))).error)
      .toMatch(/votação está aberta/i);
  });

  it("vale também para inativar", async () => {
    votingOpen = true;
    expect((await setVoterActiveAction({ error: null }, form({ active: "0" }))).error)
      .toMatch(/votação está aberta/i);
  });
});

describe("ativar e inativar", () => {
  it("inativa sem apagar nada", async () => {
    const r = await setVoterActiveAction({ error: null }, form({ active: "0" }));
    expect(r.error).toBeNull();
    expect(operacoes).toContainEqual({ tabela: "voters", op: 'update:{"active":false}' });
    expect(operacoes.filter((o) => o.op === "delete")).toHaveLength(0);
    expect(logs[0].action).toBe("VOTER_DEACTIVATED");
  });

  it("ativa de volta", async () => {
    const r = await setVoterActiveAction({ error: null }, form({ active: "1" }));
    expect(r.error).toBeNull();
    expect(operacoes).toContainEqual({ tabela: "voters", op: 'update:{"active":true}' });
    expect(logs[0].action).toBe("VOTER_ACTIVATED");
  });

  it("é a saída para quem já votou: funciona mesmo com histórico", async () => {
    estado.auditLinks = 5;
    const r = await setVoterActiveAction({ error: null }, form({ active: "0" }));
    expect(r.error).toBeNull();
  });
});

describe("identificador inválido", () => {
  it("recusa id que não é UUID, sem tocar o banco", async () => {
    const fd = new FormData();
    fd.set("voter_id", "1 OR 1=1");
    const r = await deleteVoterAction({ error: null }, fd);
    expect(r.error).toBe("Eleitor inválido.");
    expect(operacoes).toHaveLength(0);
  });
});

describe("guarda de sessão", () => {
  it("nenhuma das duas ações roda sem sessão administrativa", async () => {
    vi.resetModules();
    const semSessao = createAdminRequestScope({ authenticated: false });
    vi.doMock("next/headers", () => semSessao.nextHeaders());
    vi.doMock("next/navigation", () => semSessao.nextNavigation());
    const acoes = await import("@/app/admin/(protected)/eleitores/actions");

    for (const acao of [acoes.deleteVoterAction, acoes.setVoterActiveAction]) {
      await expect(acao({ error: null }, form())).rejects.toThrow("NEXT_REDIRECT");
    }
    expect(operacoes).toHaveLength(0);
    vi.doUnmock("next/headers");
    vi.doUnmock("next/navigation");
  });
});
