import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A urna precisa ser específica da eleição da SESSÃO.
 *
 * Antes getBallotOptions() não recebia eleição nenhuma e devolvia todos os
 * cargos e candidatos ativos — se a urna de desempate fosse alcançável,
 * mostraria a cédula inteira da eleição geral.
 */

const from = vi.fn();
const rpc = vi.fn();

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from, rpc }) }));
vi.mock("@/lib/supabase/server", () => ({ createAnonClient: () => ({ from, rpc }) }));
vi.mock("@/lib/election/positions", () => ({
  getActivePositions: async () => [
    { id: "pos-presidente", name: "Presidente", votes_per_voter: 1 },
    { id: "pos-tesouraria", name: "Tesouraria", votes_per_voter: 2 },
  ],
}));
vi.mock("@/lib/election/candidates", () => ({
  getActiveCandidates: async () => [
    {
      id: "cand-bruno",
      full_name: "Bruno",
      photo_path: null,
      positions: [{ id: "pos-presidente", slug: "p", name: "Presidente" }],
    },
    {
      id: "cand-ana",
      full_name: "Ana",
      photo_path: null,
      positions: [{ id: "pos-presidente", slug: "p", name: "Presidente" }],
    },
    {
      id: "cand-carla",
      full_name: "Carla",
      photo_path: null,
      positions: [{ id: "pos-tesouraria", slug: "t", name: "Tesouraria" }],
    },
  ],
}));

const { getBallotOptions } = await import("@/lib/election/ballot-options");

/** Encadeável que resolve conforme a tabela consultada. */
function stubTables(tables: Record<string, unknown[]>) {
  from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in"]) chain[method] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: tables[table] ?? [], error: null });
    return chain;
  });
}

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
});

/** `contested_position_ids()` — a lista de cargos com disputa, vinda do banco. */
function stubContested(ids: string[]) {
  rpc.mockImplementation(async (fn: string) =>
    fn === "contested_position_ids" ? { data: ids, error: null } : { data: null, error: null },
  );
}

describe("cédula da eleição geral", () => {
  it("traz os cargos EM DISPUTA com seus candidatos", async () => {
    stubContested(["pos-presidente", "pos-tesouraria"]);
    const options = await getBallotOptions({ electionId: "e1", type: "general" });

    expect(options.positions.map((p) => p.name)).toEqual(["Presidente", "Tesouraria"]);
    expect(options.candidatesByPosition["pos-presidente"].map((c) => c.full_name)).toEqual([
      "Ana",
      "Bruno",
    ]);
    expect(options.candidatesByPosition["pos-presidente"].map((c) => c.id)).toEqual([
      "cand-ana",
      "cand-bruno",
    ]);
    expect(options.candidatesByPosition["pos-tesouraria"].map((c) => c.full_name)).toEqual([
      "Carla",
    ]);
  });

  it("deixa de fora o cargo SEM disputa, mesmo estando ativo", async () => {
    // Tesouraria continua ativa e com candidata, mas o banco não a lista
    // como disputada: a cédula não pode pedir um voto que `cast_ballot`
    // nem sequer vai exigir.
    stubContested(["pos-presidente"]);
    const options = await getBallotOptions({ electionId: "e1", type: "general" });

    expect(options.positions.map((p) => p.id)).toEqual(["pos-presidente"]);
    expect(options.candidatesByPosition["pos-tesouraria"]).toBeUndefined();
  });

  it("sem nenhum cargo em disputa, a cédula volta vazia", async () => {
    stubContested([]);
    const options = await getBallotOptions({ electionId: "e1", type: "general" });

    expect(options.positions).toEqual([]);
    expect(options.candidatesByPosition).toEqual({});
  });
});

describe("cédula do desempate", () => {
  beforeEach(() => {
    stubTables({
      runoff_positions: [
        {
          position_id: "pos-tesouraria",
          votes_per_voter: 1,
          positions: { name: "Tesouraria", display_order: 3 },
        },
        {
          position_id: "pos-presidente",
          votes_per_voter: 1,
          positions: { name: "Presidente", display_order: 1 },
        },
      ],
      runoff_candidates: [
        {
          position_id: "pos-presidente",
          candidates: { id: "cand-bruno", full_name: "Bruno", photo_path: null, display_order: 1 },
        },
        {
          position_id: "pos-presidente",
          candidates: { id: "cand-ana", full_name: "Ana", photo_path: null, display_order: 2 },
        },
      ],
    });
  });

  it("traz SOMENTE o cargo em disputa", async () => {
    const options = await getBallotOptions({ electionId: "r1", type: "runoff" });

    expect(options.positions).toHaveLength(2);
    expect(options.positions[0]).toMatchObject({ id: "pos-presidente", name: "Presidente" });
    expect(options.positions[1]).toMatchObject({ id: "pos-tesouraria", name: "Tesouraria" });
  });

  it("traz SOMENTE os candidatos empatados", async () => {
    const options = await getBallotOptions({ electionId: "r1", type: "runoff" });

    expect(options.candidatesByPosition["pos-presidente"].map((c) => c.full_name)).toEqual([
      "Ana",
      "Bruno",
    ]);
    // Carla é candidata ativa da eleição geral, mas não deste desempate.
    expect(
      options.candidatesByPosition["pos-presidente"].some((c) => c.full_name === "Carla"),
    ).toBe(false);
  });

  it("usa os votos por eleitor das VAGAS EM DISPUTA, não os do cargo", async () => {
    // Tesouraria tem 2 votos por eleitor na geral; num desempate por 1 vaga
    // restante seria 1. O valor tem que vir de runoff_positions.
    stubTables({
      runoff_positions: [
        {
          position_id: "pos-tesouraria",
          votes_per_voter: 1,
          positions: { name: "Tesouraria", display_order: 2 },
        },
      ],
      runoff_candidates: [],
    });

    const options = await getBallotOptions({ electionId: "r1", type: "runoff" });
    expect(options.positions[0].votes_per_voter).toBe(1);
  });
});
