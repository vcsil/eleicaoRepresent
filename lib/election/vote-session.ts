import "server-only";
import { cookies } from "next/headers";

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

export const VOTE_CONFIRMED_COOKIE = "vote_confirmed";

/** Cookie de uso único que autoriza a exibição de /voto-confirmado uma vez. */
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

export async function consumeVoteConfirmedCookie(): Promise<boolean> {
  const cookieStore = await cookies();
  const has = cookieStore.get(VOTE_CONFIRMED_COOKIE)?.value === "1";
  if (has) {
    cookieStore.delete(VOTE_CONFIRMED_COOKIE);
  }
  return has;
}
