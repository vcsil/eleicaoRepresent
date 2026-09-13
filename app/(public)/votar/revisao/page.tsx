import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { deriveDraftSessionKey, getVoteSessionToken } from "@/lib/election/vote-session";
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

  const { positions, candidatesByPosition } = await getBallotOptions();
  // Amarra o rascunho local a ESTA sessão de voto (dispositivo compartilhado).
  const draftKey = buildDraftStorageKey(deriveDraftSessionKey(token));

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:px-6 sm:py-12">
      <VoteReview
        positions={positions}
        candidatesByPosition={candidatesByPosition}
        draftKey={draftKey}
      />
    </div>
  );
}
