import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { consumeVoteConfirmedCookie } from "@/lib/election/vote-session";
import { Button } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Voto confirmado" };
export const dynamic = "force-dynamic";

export default async function VotoConfirmadoPage() {
  const confirmed = await consumeVoteConfirmedCookie();
  if (!confirmed) {
    redirect("/");
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-success-bg text-success">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5 13l4 4L19 7"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h1 className="mt-6 text-2xl font-semibold text-foreground">
        Seu voto foi registrado com sucesso.
      </h1>
      <p className="mt-3 text-sm text-foreground-muted">
        O registro é definitivo — não é possível alterar ou votar novamente nesta eleição. Obrigado
        por participar!
      </p>
      <Button href="/" className="mt-8">
        Voltar ao início
      </Button>
    </div>
  );
}
