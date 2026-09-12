"use client";

import { useEffect, useState } from "react";

function getRemaining(targetIso: string) {
  const diff = Math.max(0, new Date(targetIso).getTime() - Date.now());
  const totalSeconds = Math.floor(diff / 1000);
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    done: diff === 0,
  };
}

const UNITS: { key: "days" | "hours" | "minutes" | "seconds"; label: string }[] = [
  { key: "days", label: "dias" },
  { key: "hours", label: "horas" },
  { key: "minutes", label: "min" },
  { key: "seconds", label: "seg" },
];

/**
 * Cronômetro visual (seção 6). Puramente informativo — nenhuma decisão de
 * autorização depende deste componente, sempre validada no servidor.
 */
export function Countdown({ label, targetIso }: { label: string; targetIso: string }) {
  const [remaining, setRemaining] = useState(() => getRemaining(targetIso));
  const [prevTargetIso, setPrevTargetIso] = useState(targetIso);

  if (targetIso !== prevTargetIso) {
    setPrevTargetIso(targetIso);
    setRemaining(getRemaining(targetIso));
  }

  useEffect(() => {
    const id = setInterval(() => setRemaining(getRemaining(targetIso)), 1000);
    return () => clearInterval(id);
  }, [targetIso]);

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
