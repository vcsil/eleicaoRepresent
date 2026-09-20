import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  pool,
  resetDatabase,
  createTestElection,
  releaseVoting,
  createUnreleasedElection,
  createPosition,
  createCandidate,
  createVoter,
  validateVoter,
  castBallot,
  closeVoting,
} from "./db";

/**
 * Duas regras eleitorais: a votação só abre por liberação explícita, e
 * cargo sem disputa não vai à urna.
 */
async function q(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(sql, params);
  return rows as Record<string, unknown>[];
}

const status = async (id: string) =>
  (await q("select compute_election_status($1) as s", [id]))[0].s as string;

const contested = async (id: string) =>
  (await q("select position_is_contested($1) as c", [id]))[0].c as boolean;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("liberação manual da votação", () => {
  it("a janela aberta NÃO basta: sem liberar, a votação não está em andamento", async () => {
    const id = await createUnreleasedElection();
    expect(await status(id)).toBe("aguardando_votacao");
  });

  it("liberar coloca a votação em andamento", async () => {
    const id = await createUnreleasedElection();
    await q("select release_voting($1)", [id]);
    expect(await status(id)).toBe("votacao_em_andamento");
  });

  it("recusa liberar antes da hora inicial", async () => {
    const id = await createUnreleasedElection();
    await q(
      `update election_phases set starts_on = current_date + 5, ends_on = current_date + 6
        where election_id = $1 and phase_key = 'votacao'`,
      [id],
    );
    await expect(q("select release_voting($1)", [id])).rejects.toThrow(/VOTING_NOT_STARTED/);

    const [e] = await q("select voting_released_at from elections where id = $1", [id]);
    expect(e.voting_released_at).toBeNull();
  });

  it("uma segunda liberação não altera o estado", async () => {
    const id = await createUnreleasedElection();
    const [primeira] = await q("select release_voting($1) as t", [id]);
    const [segunda] = await q("select release_voting($1) as t", [id]);
    expect(segunda.t).toEqual(primeira.t);
  });

  it("não libera eleição já encerrada", async () => {
    const id = await createUnreleasedElection();
    await closeVoting(id);
    await expect(q("select release_voting($1)", [id])).rejects.toThrow(/VOTING_ALREADY_CLOSED/);
  });

  it("não libera um desempate — a regra é da eleição geral", async () => {
    const geral = await createTestElection();
    const [runoff] = await q(
      `insert into elections (type, parent_election_id, name) values ('runoff', $1, 'D') returning id`,
      [geral],
    );
    await expect(q("select release_voting($1)", [runoff.id])).rejects.toThrow(
      /NOT_A_GENERAL_ELECTION/,
    );
  });

  it("liberada, a votação segue terminando por encerramento manual", async () => {
    const id = await createUnreleasedElection();
    await q("select release_voting($1)", [id]);
    expect(await status(id)).toBe("votacao_em_andamento");

    await closeVoting(id);
    // 'votacao_encerrada' (e não 'em_apuracao') porque a fase de apuração
    // do fixture começa em 2099: o encerramento manual continua tendo o
    // mesmo efeito de sempre, a liberação não muda o fim do ciclo.
    expect(await status(id)).toBe("votacao_encerrada");
  });
});

describe("quando um cargo tem disputa", () => {
  const casos: [string, number, number, boolean][] = [
    ["1 vaga, 1 candidato", 1, 1, false],
    ["2 vagas, 2 candidatos", 2, 2, false],
    ["2 vagas, 1 candidato", 2, 1, false],
    ["2 vagas, 3 candidatos", 2, 3, true],
    ["1 vaga, 2 candidatos", 1, 2, true],
    ["3 vagas, 0 candidatos", 3, 0, false],
  ];

  for (const [nome, vagas, candidatos, esperado] of casos) {
    it(`${nome} → ${esperado ? "DISPUTA" : "sem disputa"}`, async () => {
      await createTestElection();
      const pos = await createPosition({ vacancies: vagas, votesPerVoter: vagas });
      for (let i = 0; i < candidatos; i += 1) {
        await createCandidate(`Candidato ${i} ${nome}`, [pos.id]);
      }
      expect(await contested(pos.id)).toBe(esperado);
    });
  }

  it("candidato INATIVO não conta para a disputa", async () => {
    await createTestElection();
    const pos = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    await createCandidate("Ativo", [pos.id]);
    const inativo = await createCandidate("Inativo", [pos.id]);
    expect(await contested(pos.id)).toBe(true);

    await q("update candidates set active = false where id = $1", [inativo]);
    // 1 ativo para 1 vaga: deixou de haver escolha a fazer.
    expect(await contested(pos.id)).toBe(false);
  });
});

describe("a urna só recebe cargos disputados", () => {
  async function eleicaoComOsDoisTipos() {
    const electionId = await createTestElection();
    const disputado = await createPosition({ vacancies: 1, votesPerVoter: 1, slug: "disputado" });
    const semDisputa = await createPosition({ vacancies: 2, votesPerVoter: 2, slug: "sem-disputa" });

    const a = await createCandidate("Disputa A", [disputado.id]);
    await createCandidate("Disputa B", [disputado.id]);
    const u1 = await createCandidate("Unico 1", [semDisputa.id]);
    const u2 = await createCandidate("Unico 2", [semDisputa.id]);

    // Composição pronta: só agora a votação abre (migration 0022).
    await releaseVoting(electionId);

    return { electionId, disputado, semDisputa, a, u1, u2 };
  }

  async function token(electionId: string, nome: string) {
    const voter = await createVoter(nome);
    const sessao = await validateVoter(electionId, voter.registrationNumber, nome);
    if (sessao.status !== "ok") throw new Error(`inesperado: ${sessao.status}`);
    return sessao.token!;
  }

  it("get_current_voting_election traz só o cargo disputado", async () => {
    const { disputado } = await eleicaoComOsDoisTipos();
    const [row] = await q("select get_current_voting_election() as e");
    const ativa = row.e as { positions: { position_id: string }[] };
    expect(ativa.positions.map((p) => p.position_id)).toEqual([disputado.id]);
  });

  it("cast_ballot exige APENAS o cargo disputado", async () => {
    const { electionId, disputado, a } = await eleicaoComOsDoisTipos();
    const t = await token(electionId, "Eleitor OK");

    await expect(
      castBallot(t, {
        positions: [
          { position_id: disputado.id, allocations: [{ candidate_id: a, is_null_vote: false, quantity: 1 }] },
        ],
      }),
    ).resolves.toBeTruthy();
  });

  it("payload adulterado com cargo SEM disputa é rejeitado", async () => {
    const { electionId, disputado, semDisputa, a, u1 } = await eleicaoComOsDoisTipos();
    const t = await token(electionId, "Eleitor Adulterado");

    await expect(
      castBallot(t, {
        positions: [
          { position_id: disputado.id, allocations: [{ candidate_id: a, is_null_vote: false, quantity: 1 }] },
          { position_id: semDisputa.id, allocations: [{ candidate_id: u1, is_null_vote: false, quantity: 2 }] },
        ],
      }),
    ).rejects.toThrow(/INVALID_PAYLOAD/);
  });

  it("nenhuma cédula é gravada quando o payload é recusado", async () => {
    const { electionId, semDisputa, u1 } = await eleicaoComOsDoisTipos();
    const t = await token(electionId, "Eleitor Recusado");

    await expect(
      castBallot(t, {
        positions: [
          { position_id: semDisputa.id, allocations: [{ candidate_id: u1, is_null_vote: false, quantity: 2 }] },
        ],
      }),
    ).rejects.toThrow();

    expect(await q("select 1 from ballots where election_id = $1", [electionId])).toHaveLength(0);
  });

  it("eleição com NENHUM cargo disputado não abre urna nem gera cédula", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 2, votesPerVoter: 2 });
    await createCandidate("Sozinho", [pos.id]);
    await releaseVoting(electionId);

    const [row] = await q("select get_current_voting_election() as e");
    const ativa = row.e as { positions: unknown[] } | null;
    expect(ativa?.positions ?? []).toEqual([]);

    const t = await token(electionId, "Eleitor Sem Urna");
    await expect(
      castBallot(t, { positions: [{ position_id: pos.id, allocations: [] }] }),
    ).rejects.toThrow(/INVALID_PAYLOAD/);

    expect(await q("select 1 from ballots where election_id = $1", [electionId])).toHaveLength(0);
  });
});

describe("apuração de cargos sem disputa", () => {
  it("declara eleitos sem disputa, sem inventar votos", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 2, votesPerVoter: 2 });
    await createCandidate("Unico A", [pos.id]);
    await createCandidate("Unico B", [pos.id]);

    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    const linhas = await q(
      `select candidate_name, votes_count, elected, unopposed, tie_break_needed
         from result_snapshots where election_id = $1 and position_id = $2
        order by candidate_name`,
      [electionId, pos.id],
    );

    expect(linhas).toHaveLength(2);
    for (const linha of linhas) {
      expect(linha.elected).toBe(true);
      expect(linha.unopposed).toBe(true);
      expect(linha.tie_break_needed).toBe(false);
      expect(linha.votes_count).toBe(0);
    }
  });

  it("não cria linha de votos nulos para cargo sem disputa", async () => {
    // Ninguém votou nesse cargo: não há cédula, logo não há nulo a contar.
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    await createCandidate("Unico", [pos.id]);

    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    const nulos = await q(
      `select 1 from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id is null`,
      [electionId, pos.id],
    );
    expect(nulos).toHaveLength(0);
  });

  it("vagas sobrando ficam sem preenchimento: 2 vagas, 1 candidato", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 2, votesPerVoter: 2 });
    await createCandidate("Unico", [pos.id]);

    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    const eleitos = await q(
      `select count(*)::int as total from result_snapshots
        where election_id = $1 and position_id = $2 and elected = true`,
      [electionId, pos.id],
    );
    // 1 eleito para 2 vagas: a vaga restante é derivada (vagas - eleitos).
    expect(eleitos[0].total).toBe(1);
  });

  it("cargo SEM candidato não elege ninguém e não gera linha", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 3, votesPerVoter: 3 });

    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    expect(
      await q("select 1 from result_snapshots where election_id = $1 and position_id = $2", [
        electionId,
        pos.id,
      ]),
    ).toHaveLength(0);
  });

  it("cargo disputado continua sendo apurado por votos", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    const a = await createCandidate("Concorrente A", [pos.id]);
    await createCandidate("Concorrente B", [pos.id]);
    await releaseVoting(electionId);

    const voter = await createVoter("Eleitor Disputa");
    const sessao = await validateVoter(electionId, voter.registrationNumber, "Eleitor Disputa");
    await castBallot(sessao.token!, {
      positions: [{ position_id: pos.id, allocations: [{ candidate_id: a, is_null_vote: false, quantity: 1 }] }],
    });

    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);

    const [eleito] = await q(
      `select votes_count, unopposed from result_snapshots
        where election_id = $1 and position_id = $2 and candidate_id = $3`,
      [electionId, pos.id, a],
    );
    expect(eleito.votes_count).toBe(1);
    // Ganhou com voto: não é "eleito sem disputa".
    expect(eleito.unopposed).toBe(false);
  });

  // O antigo teste de rótulo em cargo SEM disputa foi removido: desde a
  // 0022, cargo com `seat_labels` SEMPRE vai à urna (é a votação que define
  // quem é Primeiro e quem é Segundo), então ele nunca chega ao caminho de
  // "eleito sem disputa". A ordenação por votos está coberta em
  // `tests/integration/assentos-ordenados.test.ts`.

  it("eleição só com cargos sem disputa é apurada e publicada normalmente", async () => {
    const electionId = await createTestElection();
    const pos = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    await createCandidate("Unico", [pos.id]);

    await closeVoting(electionId);
    await q("select compute_results($1)", [electionId]);
    await expect(q("select publish_results($1)", [electionId])).resolves.toBeTruthy();
  });
});

describe("E — limites da janela de votação na liberação", () => {
  async function janela(inicioDias: number, fimDias: number) {
    const id = await createUnreleasedElection();
    await q(
      `update election_phases set starts_on = current_date + ($2)::int,
                                  ends_on = current_date + ($3)::int
        where election_id = $1 and phase_key = 'votacao'`,
      [id, inicioDias, fimDias],
    );
    return id;
  }

  it("antes da janela: recusa", async () => {
    const id = await janela(5, 6);
    await expect(q("select release_voting($1)", [id])).rejects.toThrow(/VOTING_NOT_STARTED/);
  });

  it("durante a janela: libera", async () => {
    const id = await janela(-1, 1);
    await expect(q("select release_voting($1)", [id])).resolves.toBeTruthy();
  });

  it("depois da janela: recusa, sem carimbar nada", async () => {
    // Liberar aqui abriria uma urna que compute_election_status já trata
    // como encerrada: o painel diria "liberado" e o eleitorado, "encerrada".
    const id = await janela(-10, -5);
    await expect(q("select release_voting($1)", [id])).rejects.toThrow(/VOTING_WINDOW_ENDED/);

    const [e] = await q("select voting_released_at from elections where id = $1", [id]);
    expect(e.voting_released_at).toBeNull();
    expect(await status(id)).not.toBe("votacao_em_andamento");
  });

  it("modal carregado durante a janela e confirmado depois: recusa", async () => {
    const id = await janela(-1, 1);
    // A janela fecha entre abrir o modal e confirmar. A data é bem no
    // passado de propósito: `current_date - 1` às 23:59:59 em São Paulo
    // ainda é futuro enquanto o UTC está entre 00h e 03h, e o teste
    // passaria a depender da hora em que roda.
    await q(
      `update election_phases set starts_on = current_date - 6, ends_on = current_date - 5
        where election_id = $1 and phase_key = 'votacao'`,
      [id],
    );
    await expect(q("select release_voting($1)", [id])).rejects.toThrow(/VOTING_WINDOW_ENDED/);
  });

  it("uma liberação já feita continua idempotente mesmo com a janela vencida", async () => {
    // O congelamento já valeu e a votação aconteceu: recusar um reenvio
    // idempotente só produziria um erro que ninguém tem como resolver.
    const id = await janela(-1, 1);
    const [primeira] = await q("select release_voting($1) as t", [id]);
    await q(
      `update election_phases set starts_on = current_date - 6, ends_on = current_date - 5
        where election_id = $1 and phase_key = 'votacao'`,
      [id],
    );
    const [segunda] = await q("select release_voting($1) as t", [id]);
    expect(segunda.t).toEqual(primeira.t);
  });

  it("encerramento manual continua tendo precedência sobre a janela", async () => {
    const id = await janela(-1, 1);
    await closeVoting(id);
    await expect(q("select release_voting($1)", [id])).rejects.toThrow(/VOTING_ALREADY_CLOSED/);
  });

  it("janela ausente e eleição inexistente seguem com os erros próprios", async () => {
    const semJanela = await createUnreleasedElection();
    await q(`delete from election_phases where election_id = $1 and phase_key = 'votacao'`, [
      semJanela,
    ]);
    await expect(q("select release_voting($1)", [semJanela])).rejects.toThrow(
      /VOTING_WINDOW_NOT_CONFIGURED/,
    );

    await expect(
      q("select release_voting('00000000-0000-0000-0000-000000000000')"),
    ).rejects.toThrow(/ELECTION_NOT_FOUND/);
  });
});

describe("confirmação com composição desatualizada", () => {
  it("a digital acompanha a composição e recusa a liberação quando ela muda", async () => {
    const id = await createUnreleasedElection();
    const pos = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    await createCandidate("Original A", [pos.id]);
    await createCandidate("Original B", [pos.id]);

    // O administrador abre o modal: este é o estado que ele leu.
    const [antes] = await q("select composition_digest() as d");

    // Outra pessoa acrescenta um candidato.
    await createCandidate("Chegou Depois", [pos.id]);
    const [depois] = await q("select composition_digest() as d");
    expect(depois.d).not.toEqual(antes.d);

    await expect(q("select release_voting($1, $2)", [id, antes.d as string])).rejects.toThrow(
      /COMPOSITION_CHANGED/,
    );
    const [e] = await q("select voting_released_at from elections where id = $1", [id]);
    expect(e.voting_released_at).toBeNull();

    // Recarregando o resumo, a liberação passa.
    await expect(q("select release_voting($1, $2)", [id, depois.d as string])).resolves.toBeTruthy();
  });

  it("a digital muda quando um candidato é inativado", async () => {
    await createUnreleasedElection();
    const pos = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    await createCandidate("Fica", [pos.id]);
    const sai = await createCandidate("Sai", [pos.id]);

    const [antes] = await q("select composition_digest() as d");
    await q("update candidates set active = false where id = $1", [sai]);
    const [depois] = await q("select composition_digest() as d");

    // Inativar tira o cargo da disputa: é exatamente o tipo de mudança que
    // o resumo precisa refletir.
    expect(depois.d).not.toEqual(antes.d);
  });

  it("a digital muda quando as vagas do cargo mudam", async () => {
    await createUnreleasedElection();
    const pos = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    await createCandidate("Um", [pos.id]);
    await createCandidate("Dois", [pos.id]);

    const [antes] = await q("select composition_digest() as d");
    await q("update positions set vacancies = 2 where id = $1", [pos.id]);
    const [depois] = await q("select composition_digest() as d");
    expect(depois.d).not.toEqual(antes.d);
  });

  it("a digital NÃO muda por edição informativa", async () => {
    await createUnreleasedElection();
    const pos = await createPosition({ vacancies: 1, votesPerVoter: 1 });
    const a = await createCandidate("Informativo", [pos.id]);
    await createCandidate("Outro", [pos.id]);

    const [antes] = await q("select composition_digest() as d");
    await q(`update candidates set presentation = 'texto novo' where id = $1`, [a]);
    const [depois] = await q("select composition_digest() as d");
    // Trocar apresentação não muda a cédula: exigir nova revisão aqui só
    // criaria atrito sem proteger nada.
    expect(depois.d).toEqual(antes.d);
  });

  it("sem digital informada, a liberação continua funcionando", async () => {
    const id = await createUnreleasedElection();
    await expect(q("select release_voting($1, null)", [id])).resolves.toBeTruthy();
  });
});
