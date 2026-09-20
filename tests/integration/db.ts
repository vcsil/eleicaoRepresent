import { Pool } from "pg";
import { randomUUID } from "node:crypto";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/eleicao_test";

export const pool = new Pool({ connectionString: TEST_DATABASE_URL });

/**
 * positions (e candidates/voters) são globais no schema — não escopadas por
 * election_id (seção 82: normalmente uma única eleição principal ativa).
 * Cada arquivo de teste começa do zero para não interferir com o próximo
 * (fileParallelism:false garante execução sequencial, então isso é seguro).
 */
export async function resetDatabase(): Promise<void> {
  await pool.query(`
    truncate table
      audit_vote_links, ballot_choices, ballots, vote_sessions,
      result_snapshots, position_dual_winner_decisions, seat_reassignments,
      runoff_candidates, result_publications,
      candidate_positions, candidates, voters,
      runoff_positions, runoff_resolutions,
      election_phases, elections, positions,
      rate_limit_counters, security_events,
      admin_sessions, admin_logs
    cascade
  `);
}

/**
 * Cria uma eleição geral isolada (id aleatório) com as 6 posições oficiais
 * e a fase de votação aberta agora — cada arquivo de teste usa sua própria
 * eleição para não interferir com os demais mesmo sem truncar tabelas
 * globais (voters/candidates continuam únicas por matrícula/nome, então os
 * testes também geram valores únicos para essas).
 */
export async function createTestElection(released = true): Promise<string> {
  const electionId = randomUUID();
  await pool.query(`insert into elections (id, type, name) values ($1, 'general', 'Teste')`, [
    electionId,
  ]);

  const phases: [string, string, string][] = [
    ["edital", "2020-01-01", "2020-01-01"],
    ["candidaturas", "2020-01-02", "2020-01-03"],
    ["divulgacao_candidaturas", "2020-01-04", "2020-01-04"],
    ["apresentacao", "2020-01-05", "2020-01-05"],
    ["envio_videos", "2020-01-05", "2020-01-05"],
    ["apuracao", "2099-01-01", "2099-01-01"],
    ["divulgacao_resultados", "2099-01-02", "2099-01-02"],
  ];

  let order = 1;
  for (const [key, start, end] of phases) {
    await pool.query(
      `insert into election_phases (election_id, phase_key, label, starts_on, ends_on, display_order)
       values ($1, $2, $2, $3, $4, $5)`,
      [electionId, key, start, end, order++],
    );
  }

  // Votação aberta: de ontem até amanhã.
  await pool.query(
    `insert into election_phases (election_id, phase_key, label, starts_on, ends_on, display_order)
     values ($1, 'votacao', 'Votação', current_date - 1, current_date + 1, $2)`,
    [electionId, order++],
  );

  // NÃO libera aqui. Desde a migration 0022 a composição congela na
  // liberação por TRIGGER, então cadastrar cargo ou candidato depois dela
  // é recusado pelo banco — como na eleição real. Os fixtures montam a
  // composição primeiro e chamam `releaseVoting` no fim, nessa ordem.
  void released;
  return electionId;
}

/**
 * Libera a votação, como o administrador faria em /admin/votacao.
 *
 * Chame DEPOIS de criar cargos e candidatos: a partir daqui a composição
 * está congelada e o banco recusa alterá-la.
 */
export async function releaseVoting(electionId: string): Promise<void> {
  await pool.query(`select release_voting($1)`, [electionId]);
}

/** Eleição com a janela aberta mas AINDA NÃO liberada pelo administrador. */
export async function createUnreleasedElection(): Promise<string> {
  return createTestElection(false);
}

export type TestPosition = { id: string; slug: string; votesPerVoter: number; vacancies: number };

export async function createPosition(overrides: Partial<TestPosition> = {}): Promise<TestPosition> {
  const id = randomUUID();
  const slug = overrides.slug ?? `pos-${id.slice(0, 8)}`;
  const votesPerVoter = overrides.votesPerVoter ?? 1;
  const vacancies = overrides.vacancies ?? 1;

  await pool.query(
    `insert into positions (id, slug, name, vacancies, votes_per_voter, display_order, active)
     values ($1, $2, $2, $3, $4, 1, true)`,
    [id, slug, vacancies, votesPerVoter],
  );

  return { id, slug, votesPerVoter, vacancies };
}

export async function createCandidate(name: string, positionIds: string[]): Promise<string> {
  const id = randomUUID();
  await pool.query(`insert into candidates (id, full_name, active) values ($1, $2, true)`, [id, name]);
  for (const positionId of positionIds) {
    await pool.query(
      `insert into candidate_positions (candidate_id, position_id) values ($1, $2)`,
      [id, positionId],
    );
  }
  return id;
}

export async function createVoter(fullName: string, active = true): Promise<{ id: string; registrationNumber: string }> {
  const id = randomUUID();
  const registrationNumber = `reg-${id.slice(0, 12)}`;
  await pool.query(
    `insert into voters (id, registration_number, full_name, active) values ($1, $2, $3, $4)`,
    [id, registrationNumber, fullName, active],
  );
  return { id, registrationNumber };
}

export async function validateVoter(
  electionId: string,
  registrationNumber: string,
  fullName: string,
): Promise<{ status: string; token?: string; expires_at?: string }> {
  const { rows } = await pool.query(`select validate_voter($1, $2, $3) as result`, [
    electionId,
    registrationNumber,
    fullName,
  ]);
  return rows[0].result;
}

export async function castBallot(token: string, payload: unknown): Promise<string> {
  const { rows } = await pool.query(`select cast_ballot($1, $2) as ballot_id`, [
    token,
    JSON.stringify(payload),
  ]);
  return rows[0].ballot_id;
}

export async function closeVoting(electionId: string): Promise<void> {
  await pool.query(`update elections set voting_closed_manually_at = now() where id = $1`, [electionId]);
}

/** Valida o eleitor e envia a cédula, em qualquer eleição (geral ou desempate). */
export async function voteAs(
  electionId: string,
  registrationNumber: string,
  fullName: string,
  payload: unknown,
): Promise<void> {
  const session = await validateVoter(electionId, registrationNumber, fullName);
  if (session.status !== "ok" || !session.token) {
    throw new Error(`validate_voter retornou ${session.status}`);
  }
  await castBallot(session.token, payload);
}

/** Cédula de um cargo com um único candidato (ou nulo). */
export function singleChoice(positionId: string, candidateId: string | null, quantity = 1) {
  return {
    positions: [
      {
        position_id: positionId,
        allocations: [
          { candidate_id: candidateId, is_null_vote: candidateId === null, quantity },
        ],
      },
    ],
  };
}
