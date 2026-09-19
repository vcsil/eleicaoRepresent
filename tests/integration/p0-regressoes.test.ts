import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, resetDatabase } from "./db";

/**
 * Dois defeitos encontrados na auditoria do HEAD, ambos reproduzidos antes
 * de qualquer correção. Estes testes existem para que não voltem.
 */
async function q(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(sql, params);
  return rows as Record<string, unknown>[];
}

const GERAL = "11111111-1111-4111-8111-111111111111";
const POS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const POS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const POS_C = "cccccccc-0000-4000-8000-00000000000c";
const CAND_Y = "dddddddd-0000-4000-8000-0000000000dd";
const CAND_X = "eeeeeeee-0000-4000-8000-0000000000ee";

async function eleicaoComTresCargos() {
  await q(`insert into elections (id, type, name, results_computed_at) values ($1,'general','Geral', now())`, [GERAL]);
  await q(
    `insert into positions (id, slug, name, vacancies, votes_per_voter, display_order) values
       ($1,'a','Cargo A',1,1,1), ($2,'b','Cargo B',1,1,2), ($3,'c','Cargo C',1,1,3)`,
    [POS_A, POS_B, POS_C],
  );
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("dois desempates não podem ficar abertos ao mesmo tempo", () => {
  /**
   * get_current_voting_election() percorre TODOS os desempates e, achando
   * mais de um aberto, levanta AMBIGUOUS_ACTIVE_ELECTION — o que derruba
   * /votar para todos os eleitores, não só para os cargos em disputa.
   */
  async function empateEm(positionId: string) {
    const [c1] = await q(`insert into candidates (full_name) values ('C1 ' || $1) returning id`, [positionId]);
    const [c2] = await q(`insert into candidates (full_name) values ('C2 ' || $1) returning id`, [positionId]);
    for (const c of [c1, c2]) {
      await q(
        `insert into result_snapshots (election_id, position_id, candidate_id, votes_count, rank, elected, tie_break_needed)
         values ($1,$2,$3,5,1,false,true)`,
        [GERAL, positionId, c.id],
      );
    }
  }

  async function criarDesempate(positionId: string, deDias: number, ateDias: number) {
    const [row] = await q(
      `select create_runoff_election($1, array[$2]::uuid[], 'Empate',
         current_date + ($3)::int, current_date + ($4)::int, '00:00'::time, '23:59'::time) as id`,
      [GERAL, positionId, deDias, ateDias],
    );
    return row.id as string;
  }

  beforeEach(async () => {
    await eleicaoComTresCargos();
    await empateEm(POS_A);
    await empateEm(POS_B);
  });

  it("recusa criar um segundo desempate com janela sobreposta", async () => {
    await criarDesempate(POS_A, -1, 1);
    await expect(criarDesempate(POS_B, -1, 1)).rejects.toThrow(/RUNOFF_WINDOW_OVERLAP/);
  });

  it("recusa mesmo com sobreposição parcial", async () => {
    await criarDesempate(POS_A, 0, 5);
    await expect(criarDesempate(POS_B, 4, 9)).rejects.toThrow(/RUNOFF_WINDOW_OVERLAP/);
  });

  it("aceita janelas que não se sobrepõem", async () => {
    await criarDesempate(POS_A, 0, 2);
    await expect(criarDesempate(POS_B, 3, 5)).resolves.toBeTruthy();
  });

  it("a urna continua resolvível: nunca há dois desempates abertos", async () => {
    await criarDesempate(POS_A, -1, 1);
    await criarDesempate(POS_B, 3, 5).catch(() => {});

    const abertos = await q(
      `select count(*)::int as total from elections
       where type='runoff' and compute_election_status(id) = 'votacao_desempate'`,
    );
    expect(Number(abertos[0].total)).toBeLessThanOrEqual(1);
    // E a função que decide a urna não falha.
    await expect(q("select get_current_voting_election()")).resolves.toBeTruthy();
  });

  it("um desempate já publicado não bloqueia a janela de um novo", async () => {
    const primeiro = await criarDesempate(POS_A, -5, -4);
    await q(`update elections set results_computed_at = now(), results_published_at = now() where id = $1`, [primeiro]);
    await expect(criarDesempate(POS_B, -5, -4)).resolves.toBeTruthy();
  });
});

describe("promoção por cargo duplo não pode eleger alguém em dois cargos", () => {
  /**
   * Y é eleito em A e C; X é 2º em A e eleito em B. Y opta por C, X é
   * promovido em A — e passava a acumular A e B sem que nada detectasse.
   */
  beforeEach(async () => {
    await eleicaoComTresCargos();
    await q(`insert into candidates (id, full_name) values ($1,'Y'), ($2,'X')`, [CAND_Y, CAND_X]);
    await q(
      `insert into result_snapshots (election_id, position_id, candidate_id, votes_count, rank, elected, tie_break_needed) values
         ($1,$2,$4,10,1,true,false),
         ($1,$2,$5,5,2,false,false),
         ($1,$3,$5,8,1,true,false),
         ($1,$6,$4,9,1,true,false)`,
      [GERAL, POS_A, POS_B, CAND_Y, CAND_X, POS_C],
    );
    await q(
      `insert into position_dual_winner_decisions (id, election_id, candidate_id, position_id_a, position_id_b, status)
       values ('99999999-0000-4000-8000-000000000099', $1, $2, $3, $4, 'pending')`,
      [GERAL, CAND_Y, POS_A, POS_C],
    );
  });

  async function resolverEmFavorDeC() {
    await q(`select resolve_dual_winner_decision('99999999-0000-4000-8000-000000000099', $1)`, [POS_C]);
  }

  it("cria uma nova decisão pendente para o promovido", async () => {
    await resolverEmFavorDeC();
    const pendentes = await q(
      `select candidate_id from position_dual_winner_decisions where status='pending'`,
    );
    expect(pendentes).toHaveLength(1);
    expect(pendentes[0].candidate_id).toBe(CAND_X);
  });

  it("bloqueia a publicação enquanto a cascata não for resolvida", async () => {
    await resolverEmFavorDeC();
    await expect(q(`select publish_results($1)`, [GERAL])).rejects.toThrow(/DUAL_WINNER_PENDING/);
  });

  it("resolvida a cascata, a publicação é liberada e ninguém fica com dois cargos", async () => {
    await resolverEmFavorDeC();
    const [nova] = await q(`select id from position_dual_winner_decisions where status='pending'`);
    // X escolhe o Cargo B e deixa o A.
    await q(`select resolve_dual_winner_decision($1, $2)`, [nova.id, POS_B]);

    await expect(q(`select publish_results($1)`, [GERAL])).resolves.toBeTruthy();

    const acumulando = await q(
      `select candidate_id from result_snapshots
        where election_id=$1 and elected=true and candidate_id is not null
        group by candidate_id having count(distinct position_id) > 1`,
      [GERAL],
    );
    expect(acumulando).toEqual([]);
  });

  it("publish_results recusa qualquer acúmulo de cargos, mesmo sem decisão registrada", async () => {
    // Rede de segurança: estado inconsistente criado por outro caminho.
    await q(`update position_dual_winner_decisions set status='resolved', resolved_at=now()`);
    await q(
      `update result_snapshots set elected=true where election_id=$1 and position_id=$2 and candidate_id=$3`,
      [GERAL, POS_A, CAND_X],
    );
    await expect(q(`select publish_results($1)`, [GERAL])).rejects.toThrow(/DUAL_WINNER_PENDING/);
  });

  it("sem cascata, o comportamento antigo é preservado", async () => {
    // X não é eleito em lugar nenhum: promover não cria decisão nova.
    await q(`update result_snapshots set elected=false where election_id=$1 and position_id=$2`, [GERAL, POS_B]);
    await resolverEmFavorDeC();
    expect(await q(`select 1 from position_dual_winner_decisions where status='pending'`)).toHaveLength(0);
  });
});
