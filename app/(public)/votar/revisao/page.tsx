import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  deriveDraftSessionKey,
  getVoteSessionElection,
  getVoteSessionToken,
} from "@/lib/election/vote-session";
import { getBallotOptions } from "@/lib/election/ballot-options";
import { buildDraftStorageKey } from "@/lib/vote/draft";
import { VoteReview } from "@/components/vote/VoteReview";

export const metadata: Metadata = { title: "Revisão do voto" };
export const dynamic = "force-dynamic";

export default async function RevisaoPage() {
  const token = await getVoteSessionToken();
  if (!token) {
    redirect("/votar");
  }

  // A cédula é a da eleição DA SESSÃO — não a da votação que estiver
  // aberta agora. Se a votação virasse entre a validação e o envio, o
  // eleitor veria uma cédula que sua sessão não autoriza.
  const session = await getVoteSessionElection(token);
  if (!session) {
    redirect("/votar");
  }

  const { positions, candidatesByPosition } = await getBallotOptions(session);
  // Amarra o rascunho local a ESTA sessão de voto (dispositivo compartilhado).
  const draftKey = buildDraftStorageKey(deriveDraftSessionKey(token));

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:px-6 sm:py-12">
      <VoteReview
        isRunoff={session.type === "runoff"}
        positions={positions}
        candidatesByPosition={candidatesByPosition}
        draftKey={draftKey}
      />
    </div>
  );
}
