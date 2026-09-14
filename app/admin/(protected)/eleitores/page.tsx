import type { Metadata } from "next";
import { getVotersPage } from "@/lib/admin/voters";
import { parseVoterParams } from "@/lib/admin/voters-params";
import { getMainElection, getElectionStatus, isVotingOpen } from "@/lib/election/status";
import { VoterImportForm } from "@/components/admin/VoterImportForm";
import { VoterSearch } from "@/components/admin/VoterSearch";
import { VoterSortableHeader } from "@/components/admin/VoterSortableHeader";
import { VoterPagination } from "@/components/admin/VoterPagination";
import { VoterRowActions } from "@/components/admin/VoterRowActions";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export const metadata: Metadata = { title: "Eleitores — Administração" };
export const dynamic = "force-dynamic";

export default async function AdminEleitoresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Valores inválidos na URL caem no default em vez de virar erro.
  const { q: query, sort, dir, page: pageParam } = parseVoterParams(await searchParams);

  const election = await getMainElection();
  // Status autoritativo: decide apenas se a tela pede confirmação extra —
  // as Server Actions revalidam por conta própria antes de gravar.
  const votingOpen = election ? isVotingOpen(await getElectionStatus(election.id)) : false;

  // Filtra, ordena e pagina NO BANCO. `page` fora do intervalo é corrigida
  // dentro de getVotersPage, então excluir o último registro da última
  // página nunca deixa "Página 5 de 4".
  const { voters, total, activeTotal, filteredTotal, page, pageCount } = await getVotersPage({
    page: pageParam,
    query,
    sort,
    direction: dir,
  });

  const pesquisando = query.length > 0;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-foreground">Eleitores</h1>
      <p className="mt-1 text-sm text-foreground-muted">
        {total === 0 ? "Nenhum eleitor cadastrado." : `${total} cadastrados, ${activeTotal} ativos.`}
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

      {total > 0 && (
        <section className="mt-12">
          <h2 className="text-sm font-semibold text-foreground">Lista atual</h2>

          <div className="mt-3">
            <VoterSearch initialQuery={query} />
          </div>

          {pesquisando && (
            <p className="mt-2 text-xs text-foreground-muted">
              {filteredTotal === 0
                ? `Nenhum eleitor encontrado para "${query}".`
                : `${filteredTotal} ${filteredTotal === 1 ? "encontrado" : "encontrados"} para "${query}".`}
            </p>
          )}

          {voters.length > 0 && (
            <Card className="mt-3 overflow-hidden">
              {/*
                Scroll horizontal LOCAL, dentro do card: abaixo de ~500px as
                colunas só caberiam espremendo "Nome" a ponto de quebrar cada
                nome em várias linhas. O documento continua sem scroll
                horizontal — só esta caixa rola.
              */}
              <div className="max-h-[32rem] overflow-x-auto overflow-y-auto">
                <table className="w-full min-w-[38rem] text-left text-sm">
                  <thead className="sticky top-0 bg-surface-muted text-xs uppercase text-foreground-muted">
                    <tr>
                      <VoterSortableHeader
                        label="Matrícula"
                        sort="registration"
                        currentSort={sort}
                        currentDirection={dir}
                      />
                      <VoterSortableHeader
                        label="Nome"
                        sort="name"
                        currentSort={sort}
                        currentDirection={dir}
                      />
                      <VoterSortableHeader
                        label="Situação"
                        sort="status"
                        currentSort={sort}
                        currentDirection={dir}
                      />
                      <th scope="col" className="px-4 py-2.5 text-right">
                        Ações
                      </th>
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
                        <td className="px-4 py-2.5">
                          <VoterRowActions voter={voter} votingOpen={votingOpen} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {pageCount > 1 && <VoterPagination page={page} pageCount={pageCount} />}
        </section>
      )}
    </div>
  );
}
