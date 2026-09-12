import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getVoteSessionToken } from "@/lib/election/vote-session";
import { getBallotOptions } from "@/lib/election/ballot-options";
import { VoteReview } from "@/components/vote/VoteReview";

export const metadata: Metadata = { title: "Revisão do voto" };
export const dynamic = "force-dynamic";

export default async function RevisaoPage() {
  const token = await getVoteSessionToken();
  if (!token) {
    redirect("/votar");
  }

  const { positions, candidatesByPosition } = await getBallotOptions();

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:px-6 sm:py-12">
      <VoteReview positions={positions} candidatesByPosition={candidatesByPosition} />
    </div>
  );
}
