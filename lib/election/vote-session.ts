import "server-only";
import { cookies } from "next/headers";
import { hashKey } from "@/lib/security/hashing";

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
