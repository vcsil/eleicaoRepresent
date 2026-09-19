import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { getContestedPositionIds } from "@/lib/election/composition-freeze";

export type CompositionPosition = {
  id: string;
  name: string;
  vacancies: number;
  activeCandidates: number;
};

export type CompositionPreview = {
  contested: CompositionPosition[];
  uncontested: CompositionPosition[];
  /**
   * Digital do estado que este resumo descreve. Vai junto na confirmação e
   * é reconferida pelo banco dentro da transação de liberação: se alguém
   * mexeu nos candidatos nesse meio-tempo, a liberação é recusada em vez
   * de abrir a urna com uma composição que ninguém revisou.
   */
  digest: string;
};

/**
 * Como a eleição ficaria se a votação fosse liberada agora: quais cargos
 * vão à urna e quais serão decididos sem disputa.
 *
 * A separação NÃO é recalculada aqui — vem de `contested_position_ids()`,
 * a mesma função que `cast_ballot` e `get_current_voting_election` usam.
 * As contagens existem só para a tela explicar o porquê.
 */
export async function getCompositionPreview(): Promise<CompositionPreview> {
  const supabase = createServiceClient();

  const [contestedIds, digest, positionsResult, linksResult] = await Promise.all([
    getContestedPositionIds(),
    getCompositionDigest(),
    supabase
      .from("positions")
      .select("id, name, vacancies")
      .eq("active", true)
      .order("display_order", { ascending: true }),
    supabase.from("candidate_positions").select("position_id, candidates!inner ( active )"),
  ]);

  if (positionsResult.error) throw positionsResult.error;
  if (linksResult.error) throw linksResult.error;

  const ativos = new Map<string, number>();
  for (const row of (linksResult.data ?? []) as unknown as {
    position_id: string;
    candidates: { active: boolean } | null;
  }[]) {
    if (!row.candidates?.active) continue;
    ativos.set(row.position_id, (ativos.get(row.position_id) ?? 0) + 1);
  }

  const contestedSet = new Set(contestedIds);
  const contested: CompositionPosition[] = [];
  const uncontested: CompositionPosition[] = [];

  for (const row of (positionsResult.data ?? []) as {
    id: string;
    name: string;
    vacancies: number;
  }[]) {
    const entry: CompositionPosition = {
      id: row.id,
      name: row.name,
      vacancies: row.vacancies,
      activeCandidates: ativos.get(row.id) ?? 0,
    };
    (contestedSet.has(row.id) ? contested : uncontested).push(entry);
  }

  return { contested, uncontested, digest };
}

/** Digital atual da composição, calculada pelo banco. */
async function getCompositionDigest(): Promise<string> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("composition_digest");
  if (error) throw error;
  return (data ?? "") as string;
}
