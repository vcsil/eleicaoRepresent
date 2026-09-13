import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type TableRows } from "@/tests/mocks/supabase-tables";

/**
 * Validação da rota /admin/desempates/[runoffId].
 *
 * A rota recebe texto arbitrário da URL. `getRunoffDetail` é a guarda que
 * decide se aquele id é uma votação de desempate administrável DESTA
 * eleição — qualquer outra coisa precisa virar 404, nunca uma página que
 * opera sobre a eleição errada.
 */
const MAIN = "11111111-1111-4111-8111-111111111111";
const RUNOFF_1 = "22222222-2222-4222-8222-222222222222";
const RUNOFF_2 = "33333333-3333-4333-8333-333333333333";
const OUTRA_GERAL = "44444444-4444-4444-8444-444444444444";
const RUNOFF_DE_OUTRA = "55555555-5555-4555-8555-555555555555";

let tables: TableRows = {};
let statusByElection: Record<string, string> = {};

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () =>
    createFakeSupabase(tables, {
      compute_election_status: (args) =>
        statusByElection[args.p_election_id as string] ?? "aguardando_votacao",
    }).client,
}));

const { getRunoffDetail, getRunoffs } = await import("@/lib/admin/runoffs");

function eleicao(overrides: Record<string, unknown>) {
  return {
    id: RUNOFF_1,
    name: "Desempate — Presidente",
    type: "runoff",
    parent_election_id: MAIN,
    runoff_reason: "Empate",
    results_computed_at: null,
    results_published_at: null,
    created_at: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  statusByElection = { [RUNOFF_1]: "votacao_desempate" };
  tables = {
    elections: [
      { ...eleicao({ id: MAIN, type: "general", parent_election_id: null, name: "Geral" }) },
      { ...eleicao({}) },
      { ...eleicao({ id: OUTRA_GERAL, type: "general", parent_election_id: null, name: "Outra" }) },
      { ...eleicao({ id: RUNOFF_DE_OUTRA, parent_election_id: OUTRA_GERAL }) },
    ],
    result_snapshots: [],
    runoff_positions: [
      { runoff_election_id: RUNOFF_1, positions: { name: "Presidente", display_order: 1 } },
    ],
    election_phases: [
      {
        election_id: RUNOFF_1,
        phase_key: "votacao",
        starts_on: "2026-09-10",
        ends_on: "2026-09-10",
        start_time: "08:00:00",
        end_time: "18:00:00",
      },
    ],
  };
});

describe("validação do runoffId na rota de detalhe", () => {
  it("rejeita UUID malformado sem sequer consultar o banco", async () => {
    for (const invalido of ["", "abc", "nao-e-uuid", "11111111-1111-4111-8111", "../../admin"]) {
      expect(await getRunoffDetail(invalido, MAIN), invalido).toBeNull();
    }
  });

  it("rejeita UUID bem formado que não existe", async () => {
    expect(await getRunoffDetail("99999999-9999-4999-8999-999999999999", MAIN)).toBeNull();
  });

  it("rejeita a eleição geral — ela não é um desempate", async () => {
    expect(await getRunoffDetail(MAIN, MAIN)).toBeNull();
  });

  it("rejeita eleição que não é do tipo runoff, mesmo com pai na cadeia certa", async () => {
    // Sem esta checagem, uma linha com type='general' e parent_election_id
    // preenchido passaria pela validação de cadeia e seria administrada como
    // desempate. É o guard que o teste da eleição principal sozinho não
    // exercita — ela é rejeitada de todo jeito, por não ter pai.
    const FALSO = "66666666-6666-4666-8666-666666666666";
    tables.elections.push(eleicao({ id: FALSO, type: "general", parent_election_id: MAIN }));
    statusByElection[FALSO] = "votacao_em_andamento";
    expect(await getRunoffDetail(FALSO, MAIN)).toBeNull();
  });

  it("rejeita desempate que pertence a outra eleição principal", async () => {
    expect(await getRunoffDetail(RUNOFF_DE_OUTRA, MAIN)).toBeNull();
  });

  it("aceita o desempate da eleição principal", async () => {
    const detail = await getRunoffDetail(RUNOFF_1, MAIN);
    expect(detail?.id).toBe(RUNOFF_1);
    expect(detail?.parent_is_main).toBe(true);
    expect(detail?.positions).toEqual(["Presidente"]);
  });

  it("aceita rodada seguinte, filha de outro desempate da mesma eleição", async () => {
    tables.elections.push(eleicao({ id: RUNOFF_2, parent_election_id: RUNOFF_1 }));
    statusByElection[RUNOFF_2] = "votacao_desempate";
    const detail = await getRunoffDetail(RUNOFF_2, MAIN);
    expect(detail?.id).toBe(RUNOFF_2);
    // A cadeia é legítima, mas o pai não é a eleição principal.
    expect(detail?.parent_is_main).toBe(false);
    expect(detail?.parent_name).toBe("Desempate — Presidente");
  });

  it("não trava se a cadeia de pais tiver ciclo", async () => {
    tables.elections = [
      eleicao({ id: RUNOFF_1, parent_election_id: RUNOFF_2 }),
      eleicao({ id: RUNOFF_2, parent_election_id: RUNOFF_1 }),
    ];
    expect(await getRunoffDetail(RUNOFF_1, MAIN)).toBeNull();
  });

  it("expõe a janela da votação do desempate", async () => {
    const detail = await getRunoffDetail(RUNOFF_1, MAIN);
    expect(detail?.voting_window).toMatchObject({
      starts_on: "2026-09-10",
      start_time: "08:00:00",
      end_time: "18:00:00",
    });
  });
});

describe("estágio do desempate", () => {
  it("publicado aparece como concluído", async () => {
    tables.elections = [
      eleicao({ id: MAIN, type: "general", parent_election_id: null }),
      eleicao({ results_computed_at: "2026-09-11T10:00:00Z", results_published_at: "2026-09-11T12:00:00Z" }),
    ];
    const detail = await getRunoffDetail(RUNOFF_1, MAIN);
    expect(detail?.stage).toBe("concluido");
  });

  it("empate novo dentro do desempate vence 'apurado' e bloqueia a publicação", async () => {
    tables.elections = [
      eleicao({ id: MAIN, type: "general", parent_election_id: null }),
      eleicao({ results_computed_at: "2026-09-11T10:00:00Z" }),
    ];
    tables.result_snapshots = [{ election_id: RUNOFF_1, tie_break_needed: true }];
    const detail = await getRunoffDetail(RUNOFF_1, MAIN);
    // Se caísse em "apurado", a página ofereceria publicar — e publicar um
    // desempate empatado é exatamente o que não pode acontecer.
    expect(detail?.stage).toBe("novo_empate");
  });

  it("apurado sem empate fica aguardando publicação", async () => {
    tables.elections = [
      eleicao({ id: MAIN, type: "general", parent_election_id: null }),
      eleicao({ results_computed_at: "2026-09-11T10:00:00Z" }),
    ];
    const detail = await getRunoffDetail(RUNOFF_1, MAIN);
    expect(detail?.stage).toBe("apurado");
  });

  it("votação aberta e agendada usam o status autoritativo do banco", async () => {
    statusByElection[RUNOFF_1] = "votacao_desempate";
    expect((await getRunoffDetail(RUNOFF_1, MAIN))?.stage).toBe("votacao_aberta");
    statusByElection[RUNOFF_1] = "aguardando_votacao";
    expect((await getRunoffDetail(RUNOFF_1, MAIN))?.stage).toBe("agendado");
    statusByElection[RUNOFF_1] = "em_apuracao";
    expect((await getRunoffDetail(RUNOFF_1, MAIN))?.stage).toBe("aguardando_apuracao");
  });
});

describe("listagem dos desempates", () => {
  it("inclui a rodada seguinte, que é filha do desempate e não da eleição principal", async () => {
    tables.elections.push(eleicao({ id: RUNOFF_2, parent_election_id: RUNOFF_1 }));
    statusByElection[RUNOFF_2] = "aguardando_votacao";
    const ids = (await getRunoffs(MAIN)).map((r) => r.id);
    expect(ids).toContain(RUNOFF_1);
    expect(ids).toContain(RUNOFF_2);
  });

  it("não inclui eleição que não seja do tipo runoff", async () => {
    const FALSO = "66666666-6666-4666-8666-666666666666";
    tables.elections.push(eleicao({ id: FALSO, type: "general", parent_election_id: MAIN }));
    statusByElection[FALSO] = "votacao_em_andamento";
    expect((await getRunoffs(MAIN)).map((r) => r.id)).not.toContain(FALSO);
  });

  it("não inclui desempates de outra eleição principal", async () => {
    const ids = (await getRunoffs(MAIN)).map((r) => r.id);
    expect(ids).not.toContain(RUNOFF_DE_OUTRA);
  });
});
