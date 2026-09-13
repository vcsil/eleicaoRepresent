import { NextResponse } from "next/server";
import { getMainElection } from "@/lib/election/status";
import { getLiveElectionState } from "@/lib/election/live-state";

/**
 * Estado ao vivo da eleição, para o polling da home durante a votação.
 *
 * Não aceita nenhum parâmetro: a eleição é resolvida no servidor por
 * getMainElection(). Aceitar um election_id do cliente abriria sondagem de
 * ids arbitrários (uma eleição de desempate ainda não divulgada, por
 * exemplo) — sem entrada, não existe essa superfície.
 *
 * Devolve exatamente o que a home já mostrava em server render: status,
 * participação (só durante a votação, decidido no Postgres) e hora do
 * servidor. Nenhum resultado, parcial ou final, passa por aqui.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const election = await getMainElection();
    if (!election) {
      return NextResponse.json(
        { error: "unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const state = await getLiveElectionState(election.id);

    return NextResponse.json(state, {
      // Status depende de now() do Postgres: cachear aqui (browser, CDN ou
      // Data Cache) devolveria fase velha para quem está acompanhando.
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("live-state failed", error);
    return NextResponse.json(
      { error: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
