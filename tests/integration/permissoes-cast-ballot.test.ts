import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  pool,
  resetDatabase,
  createTestElection,
  createPosition,
  createCandidate,
  createVoter,
  validateVoter,
} from "./db";

/**
 * `cast_ballot` é EXCLUSIVA de `service_role`.
 *
 * Desde a 0004 ela nunca foi executável por `anon`/`authenticated` — os
 * papéis que a chave pública do Supabase assume no navegador. A migration
 * 0020 afrouxou isso por engano, e a consequência não é "votar sem token":
 * é poder chamar a função DIRETO do navegador, com um token legítimo,
 * pulando a Server Action e portanto o schema Zod, o tratamento de erro e
 * o registro de evento de segurança.
 *
 * O bypass é concreto: `ballotPositionSchema` limita `allocations` a 20 e
 * `quantity` a 50; `cast_ballot` não tem esses tetos, porque nunca
 * precisou tê-los — a única porta de entrada era a Server Action. Este
 * arquivo tranca a porta de novo.
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

async function cenario() {
  const electionId = await createTestElection();
  const pos = await createPosition({ vacancies: 1, votesPerVoter: 1, slug: "acl" });
  const a = await createCandidate("Candidato ACL A", [pos.id]);
  await createCandidate("Candidato ACL B", [pos.id]);

  const nome = `Eleitor ACL ${Date.now()}`;
  const voter = await createVoter(nome);
  const sessao = await validateVoter(electionId, voter.registrationNumber, nome);
  if (sessao.status !== "ok" || !sessao.token) throw new Error(`inesperado: ${sessao.status}`);

  return { electionId, pos, candidato: a, token: sessao.token };
}

function cedulaValida(positionId: string, candidateId: string) {
  return JSON.stringify({
    positions: [
      {
        position_id: positionId,
        allocations: [{ candidate_id: candidateId, is_null_vote: false, quantity: 1 }],
      },
    ],
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("ACL de cast_ballot", () => {
  for (const role of ["anon", "authenticated"]) {
    it(`${role} NÃO executa cast_ballot, mesmo com token válido`, async () => {
      const { pos, candidato, token } = await cenario();
      await expect(
        callAs(role, "select cast_ballot($1, $2::jsonb) as result", [
          token,
          cedulaValida(pos.id, candidato),
        ]),
      ).rejects.toThrow(/permission denied for function cast_ballot/);
    });

    it(`${role} não tem o privilégio EXECUTE registrado`, async () => {
      const { rows } = await pool.query(
        `select has_function_privilege($1, 'public.cast_ballot(text, jsonb)', 'execute') as pode`,
        [role],
      );
      expect(rows[0].pode).toBe(false);
    });
  }

  it("service_role continua registrando uma cédula válida", async () => {
    const { electionId, pos, candidato, token } = await cenario();
    const ballotId = await callAs("service_role", "select cast_ballot($1, $2::jsonb) as result", [
      token,
      cedulaValida(pos.id, candidato),
    ]);
    expect(ballotId).toBeTruthy();

    const { rows } = await pool.query(
      `select count(*)::int as total from audit_vote_links where election_id = $1`,
      [electionId],
    );
    expect(rows[0].total).toBe(1);
  });

  it("o payload que o Zod recusaria não alcança o banco por anon", async () => {
    // 22 allocations: `ballotPositionSchema` permite no máximo 20. Este é
    // exatamente o payload que a revisão conseguiu gravar. Sem EXECUTE, ele
    // para na ACL — antes de qualquer validação de conteúdo.
    const { pos, candidato, token } = await cenario();
    const allocations = Array.from({ length: 22 }, (_, i) => ({
      candidate_id: i === 0 ? candidato : null,
      is_null_vote: i !== 0,
      quantity: i === 0 ? 1 : 0,
    }));
    const payload = JSON.stringify({
      positions: [{ position_id: pos.id, allocations }],
    });

    await expect(
      callAs("anon", "select cast_ballot($1, $2::jsonb) as result", [token, payload]),
    ).rejects.toThrow(/permission denied for function cast_ballot/);
  });

  it("uma tentativa recusada não deixa cédula, escolha nem vínculo de auditoria", async () => {
    const { electionId, pos, candidato, token } = await cenario();

    await expect(
      callAs("anon", "select cast_ballot($1, $2::jsonb) as result", [
        token,
        cedulaValida(pos.id, candidato),
      ]),
    ).rejects.toThrow();

    for (const tabela of ["ballots", "ballot_choices", "audit_vote_links"]) {
      const { rows } = await pool.query(
        tabela === "ballot_choices"
          ? `select count(*)::int as total from ballot_choices bc
               join ballots b on b.id = bc.ballot_id where b.election_id = $1`
          : `select count(*)::int as total from ${tabela} where election_id = $1`,
        [electionId],
      );
      expect({ tabela, total: rows[0].total }).toEqual({ tabela, total: 0 });
    }

    // A sessão continua utilizável: a recusa foi da ACL, não do voto.
    const { rows } = await pool.query(`select consumed_at from vote_sessions limit 1`);
    expect(rows[0].consumed_at).toBeNull();
  });

  it("as demais funções eleitorais mantêm o escopo que sempre tiveram", async () => {
    // Trava a tabela de permissões inteira: a 0020 alargou cast_ballot
    // copiando o bloco de grants de uma função pública. Este teste é o que
    // faz esse erro aparecer na próxima vez.
    const esperado: Record<string, { anon: boolean; authenticated: boolean; service: boolean }> = {
      "public.cast_ballot(text, jsonb)": { anon: false, authenticated: false, service: true },
      "public.validate_voter(uuid, text, text, text, text, integer)": {
        anon: false,
        authenticated: false,
        service: true,
      },
      "public.compute_results(uuid)": { anon: false, authenticated: false, service: true },
      "public.publish_results(uuid)": { anon: false, authenticated: false, service: true },
      "public.release_voting(uuid, text)": { anon: false, authenticated: false, service: true },
      "public.composition_digest()": { anon: false, authenticated: false, service: true },
      "public.save_candidate(uuid, text, text, text, text, text, boolean, integer, uuid[], text)": {
        anon: false,
        authenticated: false,
        service: true,
      },
      "public.set_candidate_active(uuid, boolean)": {
        anon: false,
        authenticated: false,
        service: true,
      },
      "public.position_is_contested(uuid)": { anon: false, authenticated: false, service: true },
      "public.contested_position_ids()": { anon: false, authenticated: false, service: true },
      // Somente leitura de status: públicas por desenho.
      "public.compute_election_status(uuid)": { anon: true, authenticated: true, service: true },
      "public.get_current_voting_election()": { anon: true, authenticated: true, service: true },
    };

    for (const [assinatura, permissoes] of Object.entries(esperado)) {
      const { rows } = await pool.query(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service`,
        [assinatura],
      );
      expect({ assinatura, ...rows[0] }).toEqual({ assinatura, ...permissoes });
    }
  });
});
