import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getVoteSessionToken } from "@/lib/election/vote-session";
import { getBallotOptions } from "@/lib/election/ballot-options";
import { BallotWizard } from "@/components/vote/BallotWizard";

export const metadata: Metadata = { title: "Urna" };
export const dynamic = "force-dynamic";

export default async function UrnaPage() {
  const token = await getVoteSessionToken();
  if (!token) {
    redirect("/votar");
  }

  const { positions, candidatesByPosition } = await getBallotOptions();

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:px-6 sm:py-12">
      <BallotWizard positions={positions} candidatesByPosition={candidatesByPosition} />
    </div>
  );
}
