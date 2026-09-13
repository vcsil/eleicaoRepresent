import "server-only";
import { cookies } from "next/headers";
import { hashKey, sha256Hex } from "@/lib/security/hashing";
import { createServiceClient } from "@/lib/supabase/service";

export const VOTE_SESSION_COOKIE = "vote_session";
export const VOTE_SESSION_TTL_SECONDS = 60 * 20; // 20 minutos para concluir a urna

export async function setVoteSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(VOTE_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
}

export async function getVoteSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(VOTE_SESSION_COOKIE)?.value ?? null;
}

export async function clearVoteSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(VOTE_SESSION_COOKIE);
}

/**
 * Identificador público e estável da sessão de voto, usado só para nomear
 * o rascunho da urna no sessionStorage do navegador.
 *
 * Existe porque o rascunho é estado LOCAL do dispositivo, e o dispositivo
 * pode ser compartilhado: sem vínculo com a sessão, um eleitor que
 * abandona a urna deixa sua distribuição para o próximo, que a vê na tela
 * e pode enviá-la como se fosse dele.
 *
 * É um HMAC truncado do token com o segredo do servidor: não reversível,
 * não é credencial (não autoriza nada) e é determinístico — recarregar a
 * página dentro da mesma sessão devolve a mesma chave e preserva o
 * rascunho.
 */
export function deriveDraftSessionKey(token: string): string {
  return hashKey(token).slice(0, 16);
}

export const VOTE_CONFIRMED_COOKIE = "vote_confirmed";

/**
 * Libera a exibição de /voto-confirmado. Expira sozinho em 5 minutos e é
 * apagado quando um novo eleitor valida os dados (ver validateVoterAction)
 * — importante em dispositivo compartilhado, para o próximo eleitor não
 * encontrar a confirmação do anterior.
 */
export async function setVoteConfirmedCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(VOTE_CONFIRMED_COOKIE, "1", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 5,
  });
}

/**
 * SOMENTE LEITURA — não apaga o cookie.
 *
 * A versão anterior deletava aqui, e como o único chamador é a página
 * /voto-confirmado (um Server Component), isso lançava
 * "Cookies can only be modified in a Server Action or Route Handler" no
 * Next 16. E lançava exatamente no caminho de sucesso: o delete só rodava
 * quando o cookie existia, ou seja, quando o voto tinha dado certo.
 *
 * Não consumir o cookie é aceitável: ele não autoriza nada eleitoral, só
 * decide se a página de confirmação aparece. A consequência de mantê-lo é
 * que recarregar ou voltar para a tela de sucesso funciona durante 5
 * minutos, o que é melhor do que o redirecionamento brusco de antes.
 */
export async function hasVoteConfirmedCookie(): Promise<boolean> {
  const cookieStore = await cookies();
  return cookieStore.get(VOTE_CONFIRMED_COOKIE)?.value === "1";
}

/** Chamável apenas de Server Action / Route Handler. */
export async function clearVoteConfirmedCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(VOTE_CONFIRMED_COOKIE);
}

export type VoteSessionElection = {
  electionId: string;
  type: "general" | "runoff";
};

/**
 * A qual eleição a sessão de voto pertence.
 *
 * A urna precisa disso — e não pode simplesmente perguntar "qual eleição
 * está aberta agora": se a votação virasse entre a validação e o envio, a
 * tela mostraria uma cédula diferente da que a sessão autoriza. O vínculo
 * correto é o da própria sessão.
 *
 * O token nunca é guardado em claro no banco: a busca é pelo mesmo hash
 * que `cast_ballot` calcula. Sessão expirada ou já consumida não resolve
 * para eleição nenhuma.
 */
export async function getVoteSessionElection(token: string): Promise<VoteSessionElection | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("vote_sessions")
    .select("election_id, expires_at, consumed_at, elections ( type )")
    .eq("token_hash", sha256Hex(token))
    .maybeSingle();

  if (error) {
    console.error("getVoteSessionElection failed", error);
    return null;
  }
  if (!data || data.consumed_at !== null) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) return null;

  const type = (data as unknown as { elections: { type: string } | null }).elections?.type;
  if (type !== "general" && type !== "runoff") return null;

  return { electionId: data.election_id as string, type };
}
