import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A resolução da eleição aberta é do Postgres. Aqui se verifica só a
 * tradução do payload — e que um payload estranho não vire uma urna.
 */
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createAnonClient: () => ({ rpc }) }));

const { getCurrentVotingElection } = await import("@/lib/election/active-election");

beforeEach(() => {
  rpc.mockReset();
});

describe("getCurrentVotingElection", () => {
  it("traduz um desempate aberto", async () => {
    rpc.mockResolvedValue({
      data: {
        election_id: "r1",
        type: "runoff",
        parent_election_id: "e1",
        positions: [{ position_id: "p1", votes_per_voter: 1, vacancies: 1 }],
      },
      error: null,
    });

    await expect(getCurrentVotingElection()).resolves.toEqual({
      electionId: "r1",
      type: "runoff",
      parentElectionId: "e1",
      positions: [{ position_id: "p1", votes_per_voter: 1, vacancies: 1 }],
    });
  });

  it("traduz a eleição geral aberta", async () => {
    rpc.mockResolvedValue({
      data: { election_id: "e1", type: "general", parent_election_id: null, positions: [] },
      error: null,
    });

    const active = await getCurrentVotingElection();
    expect(active).toMatchObject({ electionId: "e1", type: "general", parentElectionId: null });
  });

  it("devolve null quando não há votação aberta", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(getCurrentVotingElection()).resolves.toBeNull();
  });

  it("devolve null para tipo desconhecido em vez de abrir urna", async () => {
    rpc.mockResolvedValue({ data: { election_id: "x", type: "plebiscito" }, error: null });
    await expect(getCurrentVotingElection()).resolves.toBeNull();
  });

  it("propaga erro do RPC — inclusive a ambiguidade", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "AMBIGUOUS_ACTIVE_ELECTION" } });
    await expect(getCurrentVotingElection()).rejects.toBeTruthy();
  });
});
