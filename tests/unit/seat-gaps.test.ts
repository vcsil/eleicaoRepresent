import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tradução dos fatos de banco em CAUSA da vaga vazia.
 *
 * As formas alimentadas aqui são exatamente as que
 * `tests/integration/vagas-vazias.test.ts` comprova que o Postgres produz:
 * snapshot ausente (cargo deserto), `tie_break_needed` marcado (empate
 * pendente) e `seat_reassignments.promoted_candidate_id` nulo (vaga
 * esvaziada por decisão de cargo duplo).
 *
 * Os três dão a MESMA diferença `vagas − eleitos`. O bug era exatamente
 * esse: a tela anunciava "sem candidato" nos três.
 */

const tabelas: Record<string, unknown[]> = {};

function chain(tabela: string) {
  const stub: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "in"]) stub[m] = () => stub;
  stub.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: tabelas[tabela] ?? [], error: null });
  return stub;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ from: (t: string) => chain(t) }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createAnonClient: () => ({ from: (t: string) => chain(t) }),
}));

const { getInternalResultsByPosition } = await import("@/lib/admin/results");

const ELEICAO = "11111111-1111-4111-8111-111111111111";
const CARGO = "aaaaaaaa-0000-4000-8000-000000000001";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    position_id: CARGO,
    position_name: "Cargo",
    candidate_id: "cccccccc-0000-4000-8000-000000000001",
    candidate_name: "Fulano",
    votes_count: 0,
    rank: 1,
    elected: false,
    unopposed: false,
    tie_break_needed: false,
    seat_label: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const k of Object.keys(tabelas)) delete tabelas[k];
  tabelas.positions = [{ id: CARGO, name: "Cargo", vacancies: 1, display_order: 1 }];
  tabelas.result_snapshots = [];
  tabelas.seat_reassignments = [];
  tabelas.runoff_positions = [];
});

describe("F — cargos sem snapshot continuam na revisão", () => {
  it("cargo deserto aparece com todas as vagas em aberto", async () => {
    tabelas.positions = [{ id: CARGO, name: "Cargo", vacancies: 3, display_order: 1 }];

    const [secao] = await getInternalResultsByPosition(ELEICAO);
    expect(secao).toMatchObject({
      positionId: CARGO,
      positionName: "Cargo",
      vacancies: 3,
      electedCount: 0,
    });
    expect(secao.rows).toHaveLength(0);
    expect(secao.seatGaps).toEqual([{ reason: "sem_candidatura", seats: 3 }]);
  });

  it("cargo desativado depois da apuração não some se tem resultado", async () => {
    // O histórico não pode desaparecer da revisão só porque o cargo foi
    // desativado depois.
    tabelas.positions = [];
    tabelas.result_snapshots = [
      snapshot({ elected: true, votes_count: 5, position_name: "Cargo Extinto" }),
    ];

    const secoes = await getInternalResultsByPosition(ELEICAO);
    expect(secoes).toHaveLength(1);
    expect(secoes[0].positionName).toBe("Cargo Extinto");
    expect(secoes[0].electedCount).toBe(1);
  });
});

describe("G — cada causa com o seu registro", () => {
  it("empate pendente, nunca falta de candidato", async () => {
    tabelas.result_snapshots = [
      snapshot({ candidate_id: "c1", candidate_name: "A", votes_count: 1, tie_break_needed: true }),
      snapshot({ candidate_id: "c2", candidate_name: "B", votes_count: 1, tie_break_needed: true }),
    ];

    const [secao] = await getInternalResultsByPosition(ELEICAO);
    expect(secao.seatGaps).toEqual([{ reason: "aguardando_desempate", seats: 1 }]);
    expect(secao.seatGaps.map((g) => g.reason)).not.toContain("sem_candidatura");
  });

  it("usa as vagas em disputa do desempate quando ele já existe", async () => {
    tabelas.positions = [{ id: CARGO, name: "Cargo", vacancies: 3, display_order: 1 }];
    tabelas.result_snapshots = [
      snapshot({ candidate_id: "c1", elected: true }),
      snapshot({ candidate_id: "c2", tie_break_needed: true }),
      snapshot({ candidate_id: "c3", tie_break_needed: true }),
    ];
    tabelas.runoff_positions = [
      { position_id: CARGO, vacancies_in_dispute: 2, resolved_at: null },
    ];

    const [secao] = await getInternalResultsByPosition(ELEICAO);
    expect(secao.seatGaps).toEqual([{ reason: "aguardando_desempate", seats: 2 }]);
  });

  it("desempate já resolvido não continua sendo contado", async () => {
    tabelas.result_snapshots = [snapshot({ candidate_id: "c1" })];
    tabelas.runoff_positions = [
      { position_id: CARGO, vacancies_in_dispute: 1, resolved_at: "2026-09-19T00:00:00Z" },
    ];

    const [secao] = await getInternalResultsByPosition(ELEICAO);
    expect(secao.seatGaps).toEqual([{ reason: "sem_candidatura", seats: 1 }]);
  });

  it("vaga esvaziada por cargo duplo, com candidatura existente", async () => {
    tabelas.result_snapshots = [snapshot({ candidate_id: "c1", elected: false })];
    tabelas.seat_reassignments = [{ position_id: CARGO, promoted_candidate_id: null }];

    const [secao] = await getInternalResultsByPosition(ELEICAO);
    expect(secao.seatGaps).toEqual([{ reason: "cargo_duplo", seats: 1 }]);
  });

  it("promoção bem-sucedida não gera lacuna nenhuma", async () => {
    tabelas.result_snapshots = [snapshot({ candidate_id: "c2", elected: true })];
    tabelas.seat_reassignments = [{ position_id: CARGO, promoted_candidate_id: "c2" }];

    const [secao] = await getInternalResultsByPosition(ELEICAO);
    expect(secao.seatGaps).toEqual([]);
  });

  it("causas diferentes no mesmo cargo somam separadas, sem dupla contagem", async () => {
    tabelas.positions = [{ id: CARGO, name: "Cargo", vacancies: 4, display_order: 1 }];
    tabelas.result_snapshots = [
      snapshot({ candidate_id: "c1", elected: true }),
      snapshot({ candidate_id: "c2", tie_break_needed: true }),
    ];
    tabelas.runoff_positions = [
      { position_id: CARGO, vacancies_in_dispute: 1, resolved_at: null },
    ];
    tabelas.seat_reassignments = [{ position_id: CARGO, promoted_candidate_id: null }];

    const [secao] = await getInternalResultsByPosition(ELEICAO);
    // 4 vagas, 1 eleito: 3 em aberto — 1 desempate, 1 cargo duplo, 1 deserta.
    expect(secao.seatGaps).toEqual([
      { reason: "aguardando_desempate", seats: 1 },
      { reason: "cargo_duplo", seats: 1 },
      { reason: "sem_candidatura", seats: 1 },
    ]);
    expect(secao.seatGaps.reduce((t, g) => t + g.seats, 0)).toBe(3);
  });

  it("cargo completo não inventa lacuna", async () => {
    tabelas.result_snapshots = [snapshot({ candidate_id: "c1", elected: true })];
    const [secao] = await getInternalResultsByPosition(ELEICAO);
    expect(secao.seatGaps).toEqual([]);
  });

  it("mais eleitos que vagas não produz lacuna negativa", async () => {
    tabelas.result_snapshots = [
      snapshot({ candidate_id: "c1", elected: true }),
      snapshot({ candidate_id: "c2", elected: true }),
    ];
    const [secao] = await getInternalResultsByPosition(ELEICAO);
    expect(secao.seatGaps).toEqual([]);
  });

  it("eleito sem disputa com vaga sobrando é falta de candidatura", async () => {
    tabelas.positions = [{ id: CARGO, name: "Cargo", vacancies: 2, display_order: 1 }];
    tabelas.result_snapshots = [snapshot({ candidate_id: "c1", elected: true, unopposed: true })];

    const [secao] = await getInternalResultsByPosition(ELEICAO);
    expect(secao.seatGaps).toEqual([{ reason: "sem_candidatura", seats: 1 }]);
  });
});

describe("computeSeatGaps — a aritmética isolada", () => {
  const base = {
    vacancies: 1,
    electedCount: 0,
    vacatedByDualWinner: 0,
    seatsInRunoff: 0,
    hasPendingTie: false,
  };

  it("sem vagas conhecidas, não inventa causa", async () => {
    const { computeSeatGaps } = await import("@/lib/election/seat-gaps");
    expect(computeSeatGaps({ ...base, vacancies: null })).toEqual([]);
  });

  it("cada vaga é atribuída a uma causa só", async () => {
    const { computeSeatGaps } = await import("@/lib/election/seat-gaps");
    const gaps = computeSeatGaps({
      ...base,
      vacancies: 5,
      electedCount: 1,
      vacatedByDualWinner: 1,
      seatsInRunoff: 2,
    });
    expect(gaps.reduce((t, g) => t + g.seats, 0)).toBe(4);
    expect(gaps).toEqual([
      { reason: "aguardando_desempate", seats: 2 },
      { reason: "cargo_duplo", seats: 1 },
      { reason: "sem_candidatura", seats: 1 },
    ]);
  });

  it("não atribui mais vagas do que as que faltam", async () => {
    const { computeSeatGaps } = await import("@/lib/election/seat-gaps");
    // Registros inconsistentes (mais desempates do que vagas em aberto)
    // não podem produzir um total maior que a lacuna real.
    const gaps = computeSeatGaps({
      ...base,
      vacancies: 1,
      electedCount: 0,
      vacatedByDualWinner: 3,
      seatsInRunoff: 3,
    });
    expect(gaps.reduce((t, g) => t + g.seats, 0)).toBe(1);
  });

  it("empate apurado sem desempate aberto ainda é aguardando_desempate", async () => {
    const { computeSeatGaps } = await import("@/lib/election/seat-gaps");
    expect(computeSeatGaps({ ...base, hasPendingTie: true })).toEqual([
      { reason: "aguardando_desempate", seats: 1 },
    ]);
  });

  it("os rótulos concordam em número e nunca trocam a causa", async () => {
    const { seatGapLabel, publicSeatGapLabel } = await import("@/lib/election/seat-gaps");

    expect(seatGapLabel("sem_candidatura", 1)).toMatch(/1 vaga/);
    expect(seatGapLabel("sem_candidatura", 2)).toMatch(/2 vagas/);
    expect(seatGapLabel("cargo_duplo", 1)).toMatch(/cargo duplo/);
    expect(seatGapLabel("aguardando_desempate", 1)).toMatch(/desempate/);

    // O ponto do achado: vaga em desempate ou por cargo duplo NUNCA pode
    // ser descrita como falta de candidatura, em nenhuma das duas telas.
    for (const rotulo of [seatGapLabel, publicSeatGapLabel]) {
      for (const causa of ["aguardando_desempate", "cargo_duplo"] as const) {
        expect(rotulo(causa, 1)).not.toMatch(/candidatura|candidato remanescente para promover$/);
      }
    }
    expect(publicSeatGapLabel("sem_candidatura", 1)).toMatch(/falta de candidaturas/);
  });
});
