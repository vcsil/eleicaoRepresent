import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getMainElection, getElectionStatus, ELECTION_STATUS_LABELS } from "@/lib/election/status";
import { getParticipationPercentage } from "@/lib/election/participation";
import {
  getRunoffDetail,
  getPendingTies,
  RUNOFF_STAGE_LABELS,
  type RunoffStage,
} from "@/lib/admin/runoffs";
import { getInternalResults } from "@/lib/admin/results";
import { MetricCard } from "@/components/admin/MetricCard";
import { ElectionControlPanel } from "@/components/admin/ElectionControlPanel";
import { PublishResultsButton } from "@/components/admin/PublishResultsButton";
import { CreateRunoffForm } from "@/components/admin/CreateRunoffForm";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/feedback/EmptyState";

export const metadata: Metadata = { title: "Desempate — Administração" };
export const dynamic = "force-dynamic";

const STAGE_TONE: Record<RunoffStage, "neutral" | "success" | "warning" | "info"> = {
  agendado: "neutral",
  votacao_aberta: "success",
  aguardando_apuracao: "info",
  apurado: "warning",
  novo_empate: "warning",
  concluido: "success",
};

function formatWindow(window: {
  starts_on: string | null;
  ends_on: string | null;
  start_time: string | null;
  end_time: string | null;
} | null): string {
  if (!window?.starts_on || !window.ends_on) return "Não configurada";
  const date = (value: string) => value.split("-").reverse().join("/");
  const time = (value: string | null) => (value ? value.slice(0, 5) : "--:--");
  return `${date(window.starts_on)} ${time(window.start_time)} — ${date(window.ends_on)} ${time(window.end_time)}`;
}

export default async function AdminDesempateDetalhePage({
  params,
}: {
  params: Promise<{ runoffId: string }>;
}) {
  const { runoffId } = await params;
  const election = await getMainElection();
  if (!election) {
    return <EmptyState title="Nenhuma eleição cadastrada" />;
  }

  // Validação server-side: id malformado, eleição inexistente, a eleição
  // geral, ou um desempate de outra eleição não abrem esta rota.
  const runoff = await getRunoffDetail(runoffId, election.id);
  if (!runoff) {
    notFound();
  }

  const [status, participation] = await Promise.all([
    getElectionStatus(runoff.id),
    getParticipationPercentage(runoff.id),
  ]);

  // Resultados internos só depois da apuração — antes disso não existe
  // snapshot, e resultado parcial não é exibido em lugar nenhum.
  const results = runoff.results_computed_at ? await getInternalResults(runoff.id) : [];
  const byPosition = new Map<string, typeof results>();
  for (const row of results) {
    const list = byPosition.get(row.position_id) ?? [];
    list.push(row);
    byPosition.set(row.position_id, list);
  }

  // Novo empate dentro do desempate: a próxima rodada é filha DESTE
  // desempate, então os empates pendentes são lidos do id dele.
  const nextRoundTies = runoff.stage === "novo_empate" ? await getPendingTies(runoff.id) : [];

  return (
    <div className="max-w-3xl">
      <Link href="/admin/desempates" className="text-sm text-foreground-muted hover:underline">
        ← Desempates e pendências
      </Link>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-foreground">{runoff.name}</h1>
        <Badge tone={STAGE_TONE[runoff.stage]}>{RUNOFF_STAGE_LABELS[runoff.stage]}</Badge>
      </div>

      {runoff.runoff_reason && (
        <p className="mt-2 text-sm text-foreground-muted">{runoff.runoff_reason}</p>
      )}
      {!runoff.parent_is_main && (
        <p className="mt-2 text-sm text-foreground-muted">
          Rodada seguinte de <span className="text-foreground">{runoff.parent_name}</span>.
        </p>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <MetricCard
          label={runoff.positions.length === 1 ? "Cargo em disputa" : "Cargos em disputa"}
          value={runoff.positions.length > 0 ? runoff.positions.join(", ") : "—"}
        />
        <MetricCard label="Status atual" value={ELECTION_STATUS_LABELS[status]} />
        <MetricCard label="Participação" value={`${participation.toFixed(1)}%`} />
        <MetricCard label="Janela da votação" value={formatWindow(runoff.voting_window)} />
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-foreground">Ações</h2>
        <p className="mt-1 text-sm text-foreground-muted">
          Estas ações valem apenas para esta votação de desempate. A eleição principal continua
          sendo administrada em /admin/votacao e /admin/resultados.
        </p>
        <div className="mt-4">
          <ElectionControlPanel electionId={runoff.id} status={status} />
        </div>
      </section>

      {runoff.results_computed_at && (
        <section className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-foreground">Resultados do desempate</h2>
            {runoff.stage !== "novo_empate" && (
              <PublishResultsButton
                electionId={runoff.id}
                disabled={Boolean(runoff.results_published_at)}
                label="Publicar resultado do desempate"
                description="Publicar este desempate resolve o empate da eleição principal na mesma operação. A eleição principal NÃO é publicada automaticamente — ela continua aguardando sua liberação em /admin/resultados."
              />
            )}
          </div>

          {runoff.results_published_at ? (
            <p className="mt-2 text-sm text-success">
              Desempate concluído — publicado em{" "}
              {new Date(runoff.results_published_at).toLocaleString("pt-BR")}. O empate da eleição
              principal foi resolvido. Revise e libere os resultados gerais em /admin/resultados.
            </p>
          ) : runoff.stage === "novo_empate" ? (
            <p className="mt-2 rounded-md bg-warning-bg px-3.5 py-2.5 text-sm text-warning">
              Novo empate — precisa de outra rodada. Nada é decidido automaticamente, e este
              desempate não pode ser publicado enquanto o empate persistir.
            </p>
          ) : (
            <p className="mt-2 text-sm text-foreground-muted">
              Apurado e ainda não publicado. Revise os números antes de publicar.
            </p>
          )}

          <div className="mt-6 space-y-6">
            {Array.from(byPosition.entries()).map(([positionId, rows]) => (
              <section key={positionId}>
                <h3 className="mb-2 font-semibold text-foreground">{rows[0]?.position_name}</h3>
                <Card className="divide-y divide-border">
                  {rows
                    .filter((row) => row.candidate_id !== null)
                    .map((row) => (
                      <div
                        key={row.candidate_id ?? "null"}
                        className="flex items-center justify-between gap-3 p-3 text-sm"
                      >
                        <span className="text-foreground">
                          {`${row.rank}º ${row.candidate_name}`}
                          {row.seat_label && (
                            <span className="ml-2 text-xs text-foreground-muted">
                              ({row.seat_label})
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums text-foreground-muted">
                            {row.votes_count} votos
                          </span>
                          {row.elected && <Badge tone="success">Eleito</Badge>}
                          {row.tie_break_needed && <Badge tone="warning">Empate</Badge>}
                        </span>
                      </div>
                    ))}
                  {rows
                    .filter((row) => row.candidate_id === null)
                    .map((row) => (
                      <div
                        key="null"
                        className="flex items-center justify-between gap-3 p-3 text-sm text-foreground-muted"
                      >
                        <span>Votos nulos</span>
                        <span className="tabular-nums">{row.votes_count} votos</span>
                      </div>
                    ))}
                </Card>
              </section>
            ))}
          </div>
        </section>
      )}

      {nextRoundTies.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-foreground">Criar a próxima rodada</h2>
          <p className="mt-1 text-xs text-foreground-muted">
            O critério de desempate nunca é automático — a rodada seguinte é uma nova votação,
            filha desta.
          </p>
          <div className="mt-3 space-y-4">
            {nextRoundTies.map((tie) => (
              <CreateRunoffForm key={tie.position_id} tie={tie} electionId={runoff.id} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
