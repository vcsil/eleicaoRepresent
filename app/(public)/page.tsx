import { getMainElection } from "@/lib/election/status";
import { getElectionPhases } from "@/lib/election/phases";
import { getLiveElectionState } from "@/lib/election/live-state";
import { ElectionTimeline } from "@/components/election/ElectionTimeline";
import {
  LiveElectionProvider,
  LiveStatusBadge,
  LiveVoteCta,
  LiveScheduleSection,
} from "@/components/election/LiveElectionState";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/feedback/EmptyState";
import { trackPageView } from "@/lib/analytics/track";

// Status, cronograma e participação nunca podem vir de cache estático —
// sempre calculados no servidor a cada requisição (seção 6/47).
export const dynamic = "force-dynamic";

const PILLARS = [
  {
    title: "Representação",
    description: "Fala em nome da turma nas decisões e negociações sobre a formatura.",
  },
  {
    title: "Planejamento e organização",
    description: "Estrutura o cronograma, o orçamento e as atividades até a colação de grau.",
  },
  {
    title: "Transparência",
    description: "Presta contas de decisões e recursos de forma clara para todos os colegas.",
  },
  {
    title: "Diálogo e construção coletiva",
    description: "Ouve a turma e constrói escolhas em conjunto, não isoladamente.",
  },
];

export default async function HomePage() {
  trackPageView("/");
  const election = await getMainElection();

  if (!election) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-24 sm:px-6">
        <EmptyState
          title="Eleição ainda não configurada"
          description="Assim que a eleição for cadastrada pela administração, as informações aparecerão aqui."
        />
      </div>
    );
  }

  // Um único round trip traz status E participação (get_live_election_state).
  // Antes eram duas chamadas, a segunda serial — ela só era disparada
  // depois de o status revelar que a votação estava aberta.
  const [liveState, phases] = await Promise.all([
    getLiveElectionState(election.id),
    getElectionPhases(election.id),
  ]);

  return (
    <LiveElectionProvider initialState={liveState}>
      <div>
        <section className="border-b border-border bg-surface">
          <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 sm:py-24">
            <div className="mb-5 flex justify-center">
              <LiveStatusBadge />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Comissão de Formatura — Turma 36
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-balance text-base text-foreground-muted sm:text-lg">
              Este espaço reúne as informações e o processo de escolha dos alunos responsáveis por
              organizar a formatura da turma: cronograma, cargos, candidatos e votação, tudo em um
              só lugar.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button href="/candidatos" size="lg">
                Ver candidatos
              </Button>
              <Button href="/cargos" variant="secondary" size="lg">
                Conhecer os cargos
              </Button>
              <LiveVoteCta />
            </div>
          </div>
        </section>

        <LiveScheduleSection phases={phases} />

        <section className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
          <h2 className="text-center text-2xl font-semibold text-foreground sm:text-3xl">
            Por que a Comissão de Formatura importa
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-foreground-muted">
            Um grupo eleito pela própria turma para planejar, organizar e acompanhar tudo o que
            envolve a formatura — com responsabilidade e prestação de contas constante.
          </p>

          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {PILLARS.map((pillar) => (
              <Card key={pillar.title} className="p-5">
                <h3 className="font-medium text-foreground">{pillar.title}</h3>
                <p className="mt-1.5 text-sm text-foreground-muted">{pillar.description}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="border-t border-border bg-surface">
          <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
            <h2 className="text-center text-2xl font-semibold text-foreground sm:text-3xl">
              Cronograma oficial
            </h2>
            <div className="mt-10">
              <ElectionTimeline phases={phases} />
            </div>
          </div>
        </section>
      </div>
    </LiveElectionProvider>
  );
}
