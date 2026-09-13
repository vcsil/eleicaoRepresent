"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ElectionStatusBadge } from "@/components/election/ElectionStatusBadge";
import { ParticipationProgress } from "@/components/election/ParticipationProgress";
import { Button } from "@/components/ui/Button";
import { Countdown } from "@/components/election/Countdown";
import { getCountdownConfig } from "@/lib/election/countdown";
import type { ElectionPhase } from "@/lib/election/phase-bounds";
import { isLiveState, type LiveState } from "@/lib/election/live-state-payload";

const POLL_INTERVAL_MS = 30_000;

const LiveElectionContext = createContext<LiveState | null>(null);

function useLiveState(): LiveState {
  const state = useContext(LiveElectionContext);
  if (!state) {
    throw new Error("Componente ao vivo usado fora de <LiveElectionProvider>");
  }
  return state;
}

/**
 * Mantém status e participação atualizados durante a votação, sem
 * recarregar a página.
 *
 * É um provider (e não um componente que desenha tudo) porque as partes
 * que precisam do estado ficam em seções distantes da home — badge no
 * hero, barra de participação abaixo. Com contexto, o polling acontece
 * UMA vez e os dois consumidores leem o mesmo valor; dois componentes
 * independentes fariam duas requisições a cada ciclo e poderiam exibir
 * números diferentes entre si.
 *
 * Regras de polling:
 * - 30s, e só enquanto a votação está aberta. Assim que o status sai da
 *   votação o polling para de vez: fora dela nada muda de minuto a
 *   minuto, e manter requisições para centenas de abas abertas é custo
 *   puro.
 * - Aba em background não consulta (Page Visibility). Quem volta à aba
 *   recebe atualização imediata, em vez de encarar um valor velho pelo
 *   resto do intervalo.
 * - Falha de rede mantém o último valor conhecido: um erro transitório
 *   não pode apagar o que o visitante já estava vendo. O próximo ciclo
 *   tenta de novo.
 *
 * O valor inicial vem do server render — a primeira pintura já está
 * correta, sem buraco esperando o primeiro fetch.
 *
 * Nada aqui autoriza nada: o acesso à urna continua validado no servidor
 * a cada passo, e a hora do servidor que acompanha o estado é usada só
 * para exibição.
 */
export function LiveElectionProvider({
  initialState,
  children,
}: {
  initialState: LiveState;
  children: ReactNode;
}) {
  const [state, setState] = useState<LiveState>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/public/live-state", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return;

      const payload: unknown = await response.json();
      // Payload malformado é descartado em silêncio: manter o último
      // valor bom é melhor do que renderizar lixo.
      if (isLiveState(payload)) setState(payload);
    } catch {
      // Inclui o abort do cleanup. Nada a fazer: o valor atual permanece.
    }
  }, []);

  const votingOpen = state.votingOpen;

  useEffect(() => {
    if (!votingOpen) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (timer !== null) return;
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    }

    function stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void refresh();
        start();
      } else {
        stop();
      }
    }

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      abortRef.current?.abort();
    };
  }, [votingOpen, refresh]);

  return <LiveElectionContext value={state}>{children}</LiveElectionContext>;
}

/** Badge de status que acompanha o estado ao vivo. */
export function LiveStatusBadge() {
  return <ElectionStatusBadge status={useLiveState().status} />;
}

/**
 * CTA de voto que aparece/desaparece junto com a abertura da votação —
 * sem isso, quem deixou a home aberta antes do início continuaria sem o
 * botão até recarregar.
 */
export function LiveVoteCta() {
  if (!useLiveState().votingOpen) return null;
  return (
    <Button href="/votar" variant="secondary" size="lg" className="border-success text-success">
      Votar agora
    </Button>
  );
}

/**
 * Seção de cronômetro + participação, inclusive a decisão de existir.
 *
 * A própria seção precisa ser um consumidor do estado ao vivo: se o
 * servidor renderizasse a página sem nada a mostrar e a votação abrisse
 * em seguida, uma seção escondida no HTML nunca apareceria — a barra de
 * participação só surgiria para quem recarregasse.
 *
 * O cronômetro também troca de alvo junto com o status. Sem isso a
 * atualização ao vivo ficaria incoerente: o badge mudaria para "Votação
 * em andamento" e o cronômetro continuaria zerado em "Início da votação
 * em". O cronograma chega por prop — é dado público, já exibido na
 * timeline da mesma página.
 */
export function LiveScheduleSection({ phases }: { phases: ElectionPhase[] }) {
  const state = useLiveState();
  const countdown = getCountdownConfig(state.status, phases);
  const showParticipation = state.votingOpen && state.participation !== null;

  if (!countdown && !showParticipation) return null;

  // Hora do servidor como âncora do primeiro render do cronômetro: é o que
  // faz servidor e cliente produzirem o mesmo markup. Vem do mesmo payload
  // do polling, então cada ciclo de 30s também ressincroniza o relógio.
  const serverNowMs = new Date(state.serverTime).getTime();

  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <div className="grid gap-4 sm:grid-cols-2">
        {countdown && (
          <Countdown
            label={countdown.label}
            targetIso={countdown.targetIso}
            serverNowMs={serverNowMs}
          />
        )}
        {showParticipation && (
          <div aria-live="polite">
            <ParticipationProgress percentage={state.participation as number} />
          </div>
        )}
      </div>
    </section>
  );
}
