import { describe, expect, it, vi, beforeEach } from "vitest";
import { isLiveState } from "@/lib/election/live-state-payload";

/**
 * O estado ao vivo atravessa duas fronteiras frágeis: um jsonb do Postgres
 * e uma resposta HTTP consumida pelo browser. Em ambas, um campo ausente
 * ou com tipo inesperado não pode virar tela quebrada — especialmente o
 * status, que indexa o mapa de rótulos e cores do badge.
 */

const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createAnonClient: () => ({ rpc }),
}));

const { getLiveElectionState } = await import("@/lib/election/live-state");

beforeEach(() => {
  rpc.mockReset();
});

describe("getLiveElectionState", () => {
  it("converte o jsonb do Postgres no formato usado pela home", async () => {
    rpc.mockResolvedValue({
      data: {
        status: "votacao_em_andamento",
        participation: 42.5,
        server_time: "2026-09-19T11:00:00+00:00",
      },
      error: null,
    });

    const state = await getLiveElectionState("11111111-1111-4111-8111-111111111111");

    expect(state).toEqual({
      status: "votacao_em_andamento",
      participation: 42.5,
      serverTime: "2026-09-19T11:00:00+00:00",
      votingOpen: true,
    });
  });

  it("preserva participação nula fora da votação em vez de virar zero", async () => {
    // Zero e "não divulgado" são coisas diferentes: 0% significa que
    // ninguém votou, null significa que o dado não é público agora.
    rpc.mockResolvedValue({
      data: { status: "votacao_encerrada", participation: null, server_time: "2026-09-24T00:00:00Z" },
      error: null,
    });

    const state = await getLiveElectionState("11111111-1111-4111-8111-111111111111");

    expect(state.participation).toBeNull();
    expect(state.votingOpen).toBe(false);
  });

  it("aceita participação vindo como string (numeric do Postgres)", async () => {
    rpc.mockResolvedValue({
      data: { status: "votacao_desempate", participation: "18.3", server_time: "2026-09-25T00:00:00Z" },
      error: null,
    });

    const state = await getLiveElectionState("11111111-1111-4111-8111-111111111111");

    expect(state.participation).toBe(18.3);
    expect(state.votingOpen).toBe(true);
  });

  it("falha alto quando o status é desconhecido", async () => {
    // Melhor a página cair no error boundary do que renderizar um badge
    // sem rótulo e sem cor — e é o sinal de que o enum do Postgres e o do
    // TypeScript saíram de sincronia.
    rpc.mockResolvedValue({
      data: { status: "fase_que_nao_existe", participation: null, server_time: "2026-09-19T00:00:00Z" },
      error: null,
    });

    await expect(
      getLiveElectionState("11111111-1111-4111-8111-111111111111"),
    ).rejects.toThrow(/unknown status/);
  });

  it("propaga erro do RPC", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(
      getLiveElectionState("11111111-1111-4111-8111-111111111111"),
    ).rejects.toBeTruthy();
  });
});

describe("isLiveState (guarda usada no polling do cliente)", () => {
  const valid = {
    status: "votacao_em_andamento",
    participation: 10,
    serverTime: "2026-09-19T11:00:00Z",
    votingOpen: true,
  };

  it("aceita um payload completo", () => {
    expect(isLiveState(valid)).toBe(true);
  });

  it("aceita participação nula", () => {
    expect(isLiveState({ ...valid, participation: null })).toBe(true);
  });

  it("rejeita status fora do enum", () => {
    expect(isLiveState({ ...valid, status: "qualquer_coisa" })).toBe(false);
  });

  it("rejeita participação como string", () => {
    // O cliente chama toFixed() no valor: uma string passaria pela
    // checagem frouxa de truthiness e estouraria na renderização.
    expect(isLiveState({ ...valid, participation: "10" })).toBe(false);
  });

  it("rejeita campos ausentes", () => {
    expect(isLiveState({ status: "votacao_em_andamento" })).toBe(false);
    expect(isLiveState({ ...valid, votingOpen: undefined })).toBe(false);
    expect(isLiveState({ ...valid, serverTime: undefined })).toBe(false);
  });

  it("rejeita não-objetos", () => {
    expect(isLiveState(null)).toBe(false);
    expect(isLiveState("votacao_em_andamento")).toBe(false);
    expect(isLiveState(undefined)).toBe(false);
  });
});
