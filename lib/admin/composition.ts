import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { getVotingPositionIds } from "@/lib/election/composition-freeze";

export type CompositionPosition = {
  id: string;
  name: string;
  vacancies: number;
  activeCandidates: number;
  /** Cargo com assentos nomeados: a votação define a ORDEM dos eleitos. */
  orderedSeats: boolean;
};

export type CompositionPreview = {
  /** Cargos que irão à urna. */
  voting: CompositionPosition[];
  /** Cargos decididos sem votação, na apuração. */
  nonVoting: CompositionPosition[];
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
 * vão à urna e quais serão decididos na apuração.
 *
 * A separação NÃO é recalculada aqui — vem de `voting_position_ids()`, a
 * mesma função que `cast_ballot` e `get_current_voting_election` usam. As
 * contagens e o sinal de assento nomeado existem só para a tela explicar
 * o porquê de cada cargo estar de um lado ou do outro.
 */
export async function getCompositionPreview(): Promise<CompositionPreview> {
  const supabase = createServiceClient();

  const [votingIds, digest, positionsResult, linksResult] = await Promise.all([
    getVotingPositionIds(),
    getCompositionDigest(),
    supabase
      .from("positions")
      .select("id, name, vacancies, seat_labels")
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

  const vaiAUrna = new Set(votingIds);
  const voting: CompositionPosition[] = [];
  const nonVoting: CompositionPosition[] = [];

  for (const row of (positionsResult.data ?? []) as {
    id: string;
    name: string;
    vacancies: number;
    seat_labels: string[] | null;
  }[]) {
    const entry: CompositionPosition = {
      id: row.id,
      name: row.name,
      vacancies: row.vacancies,
      activeCandidates: ativos.get(row.id) ?? 0,
      orderedSeats: row.seat_labels !== null,
    };
    (vaiAUrna.has(row.id) ? voting : nonVoting).push(entry);
  }

  return { voting, nonVoting, digest };
}

/** Digital atual da composição, calculada pelo banco. */
async function getCompositionDigest(): Promise<string> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("composition_digest");
  if (error) throw error;
  return (data ?? "") as string;
}
