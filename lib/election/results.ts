import "server-only";
import { unstable_cache } from "next/cache";
import { createAnonClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { compareCandidateResults } from "@/lib/election/display-order";

export type ResultSnapshotRow = {
  position_id: string;
  position_name: string;
  candidate_id: string | null;
  candidate_name: string | null;
  candidate_photo_path: string | null;
  votes_count: number;
  rank: number | null;
  elected: boolean;
  /** Eleito sem disputa: não houve votação neste cargo (migration 0020). */
  unopposed: boolean;
  seat_label: string | null;
};

/**
 * Lê os resultados via RLS pública (seção 51) — a policy de
 * result_snapshots só libera linhas de eleições já publicadas, então esta
 * consulta naturalmente retorna vazio antes da divulgação. Nome/foto do
 * candidato e nome do cargo são denormalizados na própria linha (não
 * dependem das policies de candidates/positions, que só liberam registros
 * ativos — seção 51 exige mostrar o resultado histórico mesmo que um
 * candidato ou cargo seja desativado depois).
 */
async function fetchPublishedResults(electionId: string): Promise<ResultSnapshotRow[]> {
  const supabase = createAnonClient();
  const { data, error } = await supabase
    .from("result_snapshots")
    .select(
      "position_id, position_name, candidate_id, candidate_name, candidate_photo_path, votes_count, rank, elected, unopposed, seat_label",
    )
    .eq("election_id", electionId);

  if (error) throw error;
  const rows = (data ?? []) as ResultSnapshotRow[];
  const candidates = rows.filter((row) => row.candidate_id !== null).sort(compareCandidateResults);
  const nullVotes = rows.filter((row) => row.candidate_id === null);
  return [...candidates, ...nullVotes];
}

/**
 * Resultados publicados são imutáveis na prática: só mudam se o admin
 * publicar, recalcular ou resolver uma pendência de composição — todas
 * essas actions invalidam `published-results`. Antes da publicação a RLS
 * já devolve vazio, e esse vazio também é invalidado na publicação.
 */
export const getPublishedResults = unstable_cache(fetchPublishedResults, ["published-results"], {
  tags: [CACHE_TAGS.publishedResults],
  revalidate: false,
});

export type RunoffRound = {
  positionId: string;
  runoffElectionId: string;
  /** Candidato que venceu o desempate e ocupou a vaga. */
  winnerCandidateIds: string[];
  rows: ResultSnapshotRow[];
};

/**
 * Rodadas de desempate que decidiram vagas desta eleição.
 *
 * Existe para o resultado público mostrar a ORIGEM da eleição: quem venceu
 * no desempate, e as duas votações lado a lado. Os snapshots do desempate
 * são lidos pela mesma RLS dos demais (só de eleição publicada), e os
 * votos da eleição original continuam intocados — são registros distintos.
 */
async function fetchRunoffRounds(parentElectionId: string): Promise<RunoffRound[]> {
  const supabase = createAnonClient();

  const { data: resolutions, error } = await supabase
    .from("runoff_resolutions")
    .select("position_id, runoff_election_id, candidate_id")
    .eq("parent_election_id", parentElectionId);

  if (error) throw error;
  if (!resolutions || resolutions.length === 0) return [];

  const byKey = new Map<string, RunoffRound>();
  for (const row of resolutions as { position_id: string; runoff_election_id: string; candidate_id: string }[]) {
    const key = `${row.runoff_election_id}:${row.position_id}`;
    const entry = byKey.get(key) ?? {
      positionId: row.position_id,
      runoffElectionId: row.runoff_election_id,
      winnerCandidateIds: [],
      rows: [],
    };
    entry.winnerCandidateIds.push(row.candidate_id);
    byKey.set(key, entry);
  }

  const rounds = Array.from(byKey.values());
  const runoffIds = Array.from(new Set(rounds.map((r) => r.runoffElectionId)));

  const { data: snapshots, error: snapshotError } = await supabase
    .from("result_snapshots")
    .select(
      "election_id, position_id, candidate_id, candidate_name, candidate_photo_path, votes_count, rank, elected, unopposed, seat_label",
    )
    .in("election_id", runoffIds);

  if (snapshotError) throw snapshotError;

  for (const row of (snapshots ?? []) as (ResultSnapshotRow & { election_id: string })[]) {
    const round = byKey.get(`${row.election_id}:${row.position_id}`);
    if (round) round.rows.push(row);
  }

  for (const round of rounds) {
    const candidates = round.rows
      .filter((row) => row.candidate_id !== null)
      .sort(compareCandidateResults);
    const nullVotes = round.rows.filter((row) => row.candidate_id === null);
    round.rows = [...candidates, ...nullVotes];
  }

  return rounds;
}

export const getRunoffRounds = unstable_cache(fetchRunoffRounds, ["runoff-rounds"], {
  tags: [CACHE_TAGS.publishedResults],
  revalidate: false,
});


/**
 * Vagas que ficaram vazias por decisão de cargo duplo — o eleito assumiu o
 * outro cargo e não havia candidato remanescente para promover.
 *
 * Existe para a tela pública não atribuir essas vagas a "falta de
 * candidatos": a diferença `vagas − eleitos` é a mesma nos dois casos, e
 * só o registro em `seat_reassignments` distingue um do outro.
 */
async function fetchVacatedSeats(electionId: string): Promise<Map<string, number>> {
  // Cliente de serviço, e não o anônimo: `seat_reassignments` é
  // deny-by-default e não tem (nem deve ganhar) policy de leitura pública —
  // antes da divulgação ela revelaria composição apurada.
  //
  // A porta é fechada AQUI, não no chamador: a função só devolve algo
  // depois de `results_published_at`. Assim nem uma chamada equivocada nem
  // uma entrada de cache anterior à publicação conseguem vazar resultado
  // parcial.
  const supabase = createServiceClient();

  const { data: election, error: electionError } = await supabase
    .from("elections")
    .select("results_published_at")
    .eq("id", electionId)
    .maybeSingle();

  if (electionError) throw electionError;
  if (!election?.results_published_at) return new Map();

  const { data, error } = await supabase
    .from("seat_reassignments")
    .select("position_id, promoted_candidate_id")
    .eq("election_id", electionId);

  if (error) throw error;

  const porCargo = new Map<string, number>();
  for (const row of (data ?? []) as {
    position_id: string;
    promoted_candidate_id: string | null;
  }[]) {
    if (row.promoted_candidate_id !== null) continue;
    porCargo.set(row.position_id, (porCargo.get(row.position_id) ?? 0) + 1);
  }
  return porCargo;
}

export const getVacatedSeatsByPosition = unstable_cache(
  fetchVacatedSeats,
  ["vacated-seats"],
  { tags: [CACHE_TAGS.publishedResults], revalidate: false },
);
