import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type PendingTie = {
  position_id: string;
  position_name: string;
  candidates: { id: string; name: string; votes_count: number }[];
};

/**
 * Empates que ainda NÃO têm votação de desempate criada.
 *
 * Filtrar aqui é o que impede o painel de continuar oferecendo "criar
 * desempate" para um cargo que já tem um em andamento — antes o formulário
 * seguia aparecendo, e só o banco barrava a duplicação.
 */
export async function getPendingTies(electionId: string): Promise<PendingTie[]> {
  const supabase = createServiceClient();
  const [{ data, error }, { data: openRunoffs, error: runoffError }] = await Promise.all([
    supabase
      .from("result_snapshots")
      .select("position_id, position_name, candidate_id, candidate_name, votes_count")
      .eq("election_id", electionId)
      .eq("tie_break_needed", true),
    supabase
      .from("runoff_positions")
      .select("position_id")
      .eq("parent_election_id", electionId)
      .is("resolved_at", null),
  ]);

  if (error) throw error;
  if (runoffError) throw runoffError;

  const jaTemDesempate = new Set((openRunoffs ?? []).map((r) => r.position_id as string));

  const byPosition = new Map<string, PendingTie>();
  for (const row of data ?? []) {
    if (!row.candidate_id) continue;
    if (jaTemDesempate.has(row.position_id)) continue;
    const entry: PendingTie = byPosition.get(row.position_id) ?? {
      position_id: row.position_id,
      position_name: row.position_name,
      candidates: [],
    };
    entry.candidates.push({
      id: row.candidate_id,
      name: row.candidate_name ?? "Candidato",
      votes_count: row.votes_count,
    });
    byPosition.set(row.position_id, entry);
  }

  return Array.from(byPosition.values());
}

export type PendingDualWinnerDecision = {
  id: string;
  candidate_id: string;
  candidate_name: string;
  position_id_a: string;
  position_name_a: string;
  position_id_b: string;
  position_name_b: string;
};

export async function getPendingDualWinnerDecisions(
  electionId: string,
): Promise<PendingDualWinnerDecision[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("position_dual_winner_decisions")
    .select(
      `id, candidate_id,
       candidates ( full_name ),
       position_a:positions!position_dual_winner_decisions_position_id_a_fkey ( id, name ),
       position_b:positions!position_dual_winner_decisions_position_id_b_fkey ( id, name )`,
    )
    .eq("election_id", electionId)
    .eq("status", "pending");

  if (error) throw error;

  type Row = {
    id: string;
    candidate_id: string;
    candidates: { full_name: string } | null;
    position_a: { id: string; name: string } | null;
    position_b: { id: string; name: string } | null;
  };

  return ((data ?? []) as unknown as Row[])
    .filter((row) => row.position_a && row.position_b)
    .map((row) => ({
      id: row.id,
      candidate_id: row.candidate_id,
      candidate_name: row.candidates?.full_name ?? "Candidato",
      position_id_a: row.position_a!.id,
      position_name_a: row.position_a!.name,
      position_id_b: row.position_b!.id,
      position_name_b: row.position_b!.name,
    }));
}

/** Onde cada desempate está no ciclo, para o painel não deixar dúvida. */
export type RunoffStage =
  | "agendado"
  | "votacao_aberta"
  | "aguardando_apuracao"
  | "apurado"
  | "novo_empate"
  | "concluido";

export const RUNOFF_STAGE_LABELS: Record<RunoffStage, string> = {
  agendado: "Agendado",
  votacao_aberta: "Votação aberta",
  aguardando_apuracao: "Encerrado — aguardando apuração",
  apurado: "Apurado — aguardando publicação",
  novo_empate: "Novo empate — precisa de outra rodada",
  concluido: "Concluído — empate resolvido",
};

export type RunoffElection = {
  id: string;
  name: string;
  runoff_reason: string | null;
  results_computed_at: string | null;
  results_published_at: string | null;
  created_at: string;
  parent_election_id: string;
  stage: RunoffStage;
  positions: string[];
};

type RunoffRow = {
  id: string;
  name: string;
  runoff_reason: string | null;
  results_computed_at: string | null;
  results_published_at: string | null;
  created_at: string;
  parent_election_id: string;
};

/** Profundidade máxima da cadeia de desempates — trava contra ciclo de dados. */
const MAX_RUNOFF_DEPTH = 20;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Todos os desempates descendentes de uma eleição, não só os filhos diretos.
 *
 * Uma rodada seguinte (empate que se repetiu) tem como pai o desempate
 * anterior, não a eleição principal. Buscar só `parent_election_id = geral`
 * fazia a rodada 2 sumir do painel — criada, votável e invisível.
 */
async function fetchRunoffChain(
  supabase: ReturnType<typeof createServiceClient>,
  rootElectionId: string,
): Promise<RunoffRow[]> {
  const columns =
    "id, name, runoff_reason, results_computed_at, results_published_at, created_at, parent_election_id";
  const found: RunoffRow[] = [];
  const seen = new Set<string>([rootElectionId]);
  let frontier = [rootElectionId];

  for (let depth = 0; depth < MAX_RUNOFF_DEPTH && frontier.length > 0; depth += 1) {
    const { data, error } = await supabase
      .from("elections")
      .select(columns)
      .eq("type", "runoff")
      .in("parent_election_id", frontier)
      .order("created_at", { ascending: false });
    if (error) throw error;

    const rows = ((data ?? []) as RunoffRow[]).filter((row) => !seen.has(row.id));
    for (const row of rows) seen.add(row.id);
    found.push(...rows);
    frontier = rows.map((row) => row.id);
  }

  return found;
}

/**
 * Em que ponto do ciclo cada desempate está.
 *
 * A ordem dos testes importa: publicado vence tudo, e um empate novo dentro
 * do desempate vence "apurado" — porque apurado sugere que basta publicar, e
 * nesse caso não basta.
 */
function resolveStage(
  row: Pick<RunoffRow, "results_computed_at" | "results_published_at">,
  hasNewTie: boolean,
  status: string | undefined,
): RunoffStage {
  if (row.results_published_at) return "concluido";
  if (hasNewTie) return "novo_empate";
  if (row.results_computed_at) return "apurado";
  if (status === "votacao_desempate") return "votacao_aberta";
  if (status === "aguardando_votacao") return "agendado";
  return "aguardando_apuracao";
}

async function fetchStageInputs(
  supabase: ReturnType<typeof createServiceClient>,
  ids: string[],
): Promise<{
  statusById: Map<string, string>;
  withNewTie: Set<string>;
  positionsById: Map<string, string[]>;
}> {
  const [statuses, { data: ties, error: tiesError }, { data: positions, error: positionsError }] =
    await Promise.all([
      // O status é autoritativo e depende de now(): uma chamada por desempate,
      // em paralelo. São poucos por eleição.
      Promise.all(
        ids.map(async (id) => {
          const { data: status } = await supabase.rpc("compute_election_status", {
            p_election_id: id,
          });
          return [id, status as string] as const;
        }),
      ),
      supabase
        .from("result_snapshots")
        .select("election_id")
        .in("election_id", ids)
        .eq("tie_break_needed", true),
      supabase
        .from("runoff_positions")
        .select("runoff_election_id, positions ( name, display_order )")
        .in("runoff_election_id", ids),
    ]);

  if (tiesError) throw tiesError;
  if (positionsError) throw positionsError;

  const positionRows = (positions ?? []) as unknown as {
    runoff_election_id: string;
    positions: { name: string; display_order: number } | null;
  }[];

  const ordered = new Map<string, { name: string; display_order: number }[]>();
  for (const row of positionRows) {
    if (!row.positions) continue;
    const list = ordered.get(row.runoff_election_id) ?? [];
    list.push(row.positions);
    ordered.set(row.runoff_election_id, list);
  }

  const positionsById = new Map<string, string[]>();
  for (const [id, list] of ordered) {
    positionsById.set(
      id,
      list.sort((a, b) => a.display_order - b.display_order).map((p) => p.name),
    );
  }

  return {
    statusById: new Map(statuses),
    withNewTie: new Set((ties ?? []).map((t) => t.election_id as string)),
    positionsById,
  };
}

export async function getRunoffs(electionId: string): Promise<RunoffElection[]> {
  const supabase = createServiceClient();
  const runoffs = await fetchRunoffChain(supabase, electionId);
  if (runoffs.length === 0) return [];

  const ids = runoffs.map((r) => r.id);
  const { statusById, withNewTie, positionsById } = await fetchStageInputs(supabase, ids);

  return runoffs.map((runoff) => ({
    ...runoff,
    stage: resolveStage(runoff, withNewTie.has(runoff.id), statusById.get(runoff.id)),
    positions: positionsById.get(runoff.id) ?? [],
  }));
}

export type RunoffVotingWindow = {
  starts_on: string | null;
  ends_on: string | null;
  start_time: string | null;
  end_time: string | null;
};

export type RunoffDetail = RunoffElection & {
  parent_name: string;
  parent_is_main: boolean;
  voting_window: RunoffVotingWindow | null;
};

/**
 * Carrega UM desempate, validando no servidor que ele é administrável.
 *
 * A rota `/admin/desempates/[runoffId]` recebe texto arbitrário da URL. Um
 * UUID qualquer, o id da eleição geral ou o desempate de outra eleição não
 * podem ser tratados como desempate desta — daí a subida pela cadeia de
 * `parent_election_id` até a eleição principal esperada. Devolve `null`
 * quando nada disso se confirma; a página responde com 404.
 */
export async function getRunoffDetail(
  runoffId: string,
  mainElectionId: string,
): Promise<RunoffDetail | null> {
  // Barra antes de tocar o banco: um id malformado viraria erro 22P02 do
  // Postgres, não um 404.
  if (!UUID_PATTERN.test(runoffId)) return null;

  const supabase = createServiceClient();
  const columns =
    "id, name, type, runoff_reason, results_computed_at, results_published_at, created_at, parent_election_id";

  const { data, error } = await supabase
    .from("elections")
    .select(columns)
    .eq("id", runoffId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const runoff = data as RunoffRow & { type: string };
  // A eleição geral tem type 'general' e nunca é administrada por esta rota.
  if (runoff.type !== "runoff" || !runoff.parent_election_id) return null;

  // Sobe a cadeia: o pai pode ser a eleição principal (rodada 1) ou outro
  // desempate dela (rodada 2+). Qualquer outra origem é rejeitada.
  let cursor: string | null = runoff.parent_election_id;
  let parentName: string | null = null;
  let belongsToMain = false;
  const visited = new Set<string>([runoff.id]);

  for (let depth = 0; depth < MAX_RUNOFF_DEPTH && cursor && !visited.has(cursor); depth += 1) {
    visited.add(cursor);
    const { data: parent, error: parentError } = await supabase
      .from("elections")
      .select("id, name, type, parent_election_id")
      .eq("id", cursor)
      .maybeSingle();
    if (parentError) throw parentError;
    if (!parent) break;

    const row = parent as { id: string; name: string; type: string; parent_election_id: string | null };
    if (depth === 0) parentName = row.name;
    if (row.id === mainElectionId) {
      belongsToMain = true;
      break;
    }
    // Só desempate continua a cadeia; outra eleição geral encerra a busca.
    if (row.type !== "runoff") break;
    cursor = row.parent_election_id;
  }

  if (!belongsToMain) return null;

  const [{ statusById, withNewTie, positionsById }, { data: phase, error: phaseError }] =
    await Promise.all([
      fetchStageInputs(supabase, [runoff.id]),
      supabase
        .from("election_phases")
        .select("starts_on, ends_on, start_time, end_time")
        .eq("election_id", runoff.id)
        .eq("phase_key", "votacao")
        .maybeSingle(),
    ]);
  if (phaseError) throw phaseError;

  return {
    id: runoff.id,
    name: runoff.name,
    runoff_reason: runoff.runoff_reason,
    results_computed_at: runoff.results_computed_at,
    results_published_at: runoff.results_published_at,
    created_at: runoff.created_at,
    parent_election_id: runoff.parent_election_id,
    stage: resolveStage(runoff, withNewTie.has(runoff.id), statusById.get(runoff.id)),
    positions: positionsById.get(runoff.id) ?? [],
    parent_name: parentName ?? "Eleição principal",
    parent_is_main: runoff.parent_election_id === mainElectionId,
    voting_window: (phase as RunoffVotingWindow | null) ?? null,
  };
}
