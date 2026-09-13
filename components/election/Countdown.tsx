"use client";

import { useEffect, useState } from "react";
import { getRemaining } from "@/lib/election/countdown";

const UNITS: { key: "days" | "hours" | "minutes" | "seconds"; label: string }[] = [
  { key: "days", label: "dias" },
  { key: "hours", label: "horas" },
  { key: "minutes", label: "min" },
  { key: "seconds", label: "seg" },
];

/**
 * Cronômetro visual (seção 6). Puramente informativo — nenhuma decisão de
 * autorização depende deste componente, sempre validada no servidor.
 *
 * Duas regras dão conta do hydration mismatch e do relógio do visitante:
 *
 * 1. O PRIMEIRO render (servidor e hidratação) usa `serverNowMs`, um
 *    instante fixo vindo do Postgres. Como os dois lados calculam a partir
 *    do mesmo número, o markup é idêntico e o React não reclama. A versão
 *    anterior chamava `Date.now()` durante o render, então os segundos
 *    divergiam pelo tempo entre gerar o HTML e hidratar.
 *
 * 2. Depois da hidratação, um efeito mede a diferença entre a hora do
 *    servidor e a do navegador e passa a contar com `Date.now() + offset`.
 *    Assim o cronômetro segue a hora do servidor mesmo em dispositivo com
 *    relógio desregulado — e continua tudo local, sem nenhuma requisição
 *    por segundo. O `serverNowMs` é reaproveitado do polling de 30s que já
 *    existe, então a ressincronização é de graça.
 */
export function Countdown({
  label,
  targetIso,
  serverNowMs,
}: {
  label: string;
  targetIso: string;
  serverNowMs: number;
}) {
  // Primeiro render (servidor E hidratação): snapshot do servidor. Nenhuma
  // leitura de relógio acontece durante o render — é isso que garante
  // markup idêntico dos dois lados.
  const [remaining, setRemaining] = useState(() => getRemaining(targetIso, serverNowMs));

  useEffect(() => {
    const offsetMs = serverNowMs - Date.now();
    const update = () => setRemaining(getRemaining(targetIso, Date.now() + offsetMs));
    // Corrige imediatamente o atraso entre gerar o HTML e hidratar.
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [targetIso, serverNowMs]);

  return (
    <div
      className="rounded-lg border border-border bg-surface p-4 sm:p-5"
      role="timer"
      aria-live="off"
    >
      <p className="text-sm font-medium text-foreground-muted">{label}</p>
      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        {UNITS.map((unit) => (
          <div key={unit.key} className="rounded-md bg-surface-muted py-2">
            <span className="block text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
              {String(remaining[unit.key]).padStart(2, "0")}
            </span>
            <span className="block text-[11px] uppercase tracking-wide text-foreground-muted">
              {unit.label}
            </span>
          </div>
        ))}
      </div>
      <span className="sr-only" aria-live="polite">
        {remaining.done
          ? "Prazo encerrado"
          : `Faltam ${remaining.days} dias, ${remaining.hours} horas, ${remaining.minutes} minutos e ${remaining.seconds} segundos`}
      </span>
    </div>
  );
}
