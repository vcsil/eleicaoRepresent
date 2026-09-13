import type { Metadata } from "next";
import { getVoters } from "@/lib/admin/voters";
import { getMainElection, getElectionStatus, isVotingOpen } from "@/lib/election/status";
import { VoterImportForm } from "@/components/admin/VoterImportForm";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export const metadata: Metadata = { title: "Eleitores — Administração" };
export const dynamic = "force-dynamic";

export default async function AdminEleitoresPage() {
  const election = await getMainElection();
  // Status autoritativo: decide apenas se a tela pede confirmação extra —
  // a Server Action revalida por conta própria antes de gravar.
  const votingOpen = election ? isVotingOpen(await getElectionStatus(election.id)) : false;
  const voters = await getVoters();

  const ativos = voters.filter((v) => v.active).length;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-foreground">Eleitores</h1>
      <p className="mt-1 text-sm text-foreground-muted">
        {voters.length === 0
          ? "Nenhum eleitor cadastrado."
          : `${voters.length} cadastrados, ${ativos} ativos.`}
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-foreground">Importar eleitores</h2>
        <p className="mt-1 text-xs text-foreground-muted">
          Envie a lista oficial em .csv ou .xlsx. Você confere a leitura antes de qualquer
          gravação — nada é importado ao selecionar o arquivo.
        </p>
        <div className="mt-3">
          <VoterImportForm votingOpen={votingOpen} />
        </div>
      </section>

      {voters.length > 0 && (
        <section className="mt-12">
          <h2 className="text-sm font-semibold text-foreground">Lista atual</h2>
          <Card className="mt-3 overflow-hidden">
            <div className="max-h-[32rem] overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-surface-muted text-xs uppercase text-foreground-muted">
                  <tr>
                    <th className="px-4 py-2.5">Matrícula</th>
                    <th className="px-4 py-2.5">Nome</th>
                    <th className="px-4 py-2.5">Situação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {voters.map((voter) => (
                    <tr key={voter.id}>
                      <td className="px-4 py-2.5 font-mono text-foreground">
                        {voter.registration_number}
                      </td>
                      <td className="px-4 py-2.5 text-foreground">{voter.full_name}</td>
                      <td className="px-4 py-2.5">
                        {voter.active ? (
                          <Badge tone="success">Ativo</Badge>
                        ) : (
                          <Badge tone="neutral">Inativo</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}
