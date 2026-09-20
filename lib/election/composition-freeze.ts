import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * A composição está congelada?
 *
 * Congela na LIBERAÇÃO da votação, não no encerramento: depois que a urna
 * abre, mudar quem concorre mudaria a cédula debaixo de quem já votou — e,
 * como cargo sem disputa sai da urna, um candidato a mais ou a menos pode
 * até criar ou apagar um cargo inteiro da cédula.
 *
 * Estado autoritativo do banco (`elections.voting_released_at`), nunca do
 * relógio do navegador nem de botão desabilitado na tela: o botão some por
 * cortesia, a recusa acontece na Server Action.
 *
 * Irreversível por natureza: `voting_released_at` só é escrito por
 * `release_voting`, que nunca volta a nulo.
 */
export async function electionIsFrozen(): Promise<boolean> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("elections")
    .select("voting_released_at")
    .eq("type", "general")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  // Erro de leitura não pode virar "pode editar": na dúvida, congelado.
  if (error) {
    console.error("electionIsFrozen failed", error);
    return true;
  }
  return data?.voting_released_at != null;
}

/**
 * Cargos que VÃO À URNA, pela definição do banco
 * (`position_requires_voting`, migration 0022):
 *
 *   candidatos > 0 E (seat_labels IS NOT NULL OU candidatos > vagas)
 *
 * Cargo com assentos nomeados (Tesouraria, Secretaria) vota sempre que
 * houver candidato, porque é a votação que define Primeiro e Segundo.
 *
 * Nunca recalculado em TypeScript: é a MESMA função que `cast_ballot` usa
 * para decidir o que a cédula precisa trazer. Duplicar a regra aqui seria
 * abrir espaço para a tela e o banco discordarem.
 */
export async function getVotingPositionIds(): Promise<string[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("voting_position_ids");
  if (error) throw error;
  return (data ?? []) as string[];
}
