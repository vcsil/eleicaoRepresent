import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, resetDatabase, createTestElection, createVoter, closeVoting } from "./db";

/**
 * Permissões das funções chamadas por RPC.
 *
 * Este arquivo existe porque GRANT já quebrou este projeto duas vezes em
 * produção (migrations 0010 e 0011): funções recebem EXECUTE a PUBLIC por
 * padrão na criação, os REVOKEs de segurança tiram também o acesso que
 * service_role herdaria de PUBLIC, e nada disso aparece em typecheck,
 * lint ou build — só em runtime, com "permission denied". Aqui a ACL é
 * verificada direto no banco.
 *
 * Vale tanto para o que DEVE ser permitido quanto para o que deve ser
 * negado: uma função administrativa alcançável com a chave pública é um
 * vazamento, não um detalhe de configuração.
 */

/**
 * Executa `sql` assumindo `role`, numa transação própria.
 *
 * A transação não é cosmética: `set local role` só vale dentro de um
 * bloco transacional — fora dele o comando é ignorado e a consulta
 * rodaria como o superusuário da conexão, fazendo este teste "passar"
 * sem nunca ter trocado de papel. `set local` também desfaz a troca
 * sozinho no fim da transação, então a conexão volta limpa para o pool.
 */
async function callAs(role: string, sql: string, params: unknown[] = []): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    const { rows } = await client.query(sql, params);
    await client.query("commit");
    return rows[0]?.result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

describe("permissões das funções de leitura consolidada (migration 0012)", () => {
  let electionId: string;

  beforeAll(async () => {
    await resetDatabase();
    electionId = await createTestElection();
    await createVoter("Eleitor Um");
    await createVoter("Eleitor Dois");
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("get_admin_dashboard_metrics — administrativa", () => {
    it("service_role executa", async () => {
      const result = await callAs(
        "service_role",
        "select get_admin_dashboard_metrics($1) as result",
        [electionId],
      );
      expect(result).toMatchObject({ total_voters: 2 });
    });

    // anon e authenticated são os papéis que a chave pública do Supabase
    // assume: se qualquer um dos dois executasse, contagens de eventos de
    // segurança ficariam legíveis a partir do browser.
    for (const role of ["anon", "authenticated"]) {
      it(`${role} recebe permission denied`, async () => {
        await expect(
          callAs(role, "select get_admin_dashboard_metrics($1) as result", [electionId]),
        ).rejects.toThrow(/permission denied for function get_admin_dashboard_metrics/);
      });
    }
  });

  describe("get_live_election_state — pública", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      it(`${role} executa`, async () => {
        const result = (await callAs(role, "select get_live_election_state($1) as result", [
          electionId,
        ])) as Record<string, unknown>;
        expect(result.status).toBe("votacao_em_andamento");
      });
    }

    it("não devolve nenhum campo além de status, participação e hora do servidor", async () => {
      const result = (await callAs("anon", "select get_live_election_state($1) as result", [
        electionId,
      ])) as Record<string, unknown>;
      // Trava contra alguém acrescentar um campo sensível aqui no futuro:
      // este é um payload público, servido sem autenticação.
      expect(Object.keys(result).sort()).toEqual(["participation", "server_time", "status"]);
    });

    it("expõe participação durante a votação", async () => {
      const result = (await callAs("anon", "select get_live_election_state($1) as result", [
        electionId,
      ])) as Record<string, unknown>;
      expect(Number(result.participation)).toBe(0);
    });

    it("omite participação quando a votação não está aberta (seção 47)", async () => {
      await closeVoting(electionId);
      const result = (await callAs("anon", "select get_live_election_state($1) as result", [
        electionId,
      ])) as Record<string, unknown>;
      expect(result.status).not.toBe("votacao_em_andamento");
      expect(result.participation).toBeNull();
    });
  });
});
