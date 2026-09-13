"use client";

import { useId, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Sheet } from "@/components/ui/Sheet";
import type { DailySiteAccessStat } from "@/lib/admin/site-access-series";

function formatDate(date: string, includeYear = false): string {
  const [year, month, day] = date.split("-");
  return includeYear ? `${day}/${month}/${year}` : `${day}/${month}`;
}

function SiteAccessChart({ data }: { data: DailySiteAccessStat[] }) {
  const [selectedDate, setSelectedDate] = useState(data.at(-1)?.date ?? null);
  const selected = data.find((point) => point.date === selectedDate) ?? data.at(-1);
  const maximum = Math.max(1, ...data.map((point) => point.views));
  const axisMaximum = Math.max(...data.map((point) => point.views));
  const middleTick = Math.round(axisMaximum / 2);

  return (
    <div>
      <div className="mb-4 min-h-12 rounded-lg bg-surface-muted px-3 py-2" aria-live="polite">
        {selected && (
          <>
            <p className="text-sm font-medium text-foreground">{formatDate(selected.date, true)}</p>
            <p className="text-sm text-foreground-muted">
              {selected.views} {selected.views === 1 ? "acesso" : "acessos"}
            </p>
          </>
        )}
      </div>

      <div className="flex h-64 min-w-0 gap-2" aria-label="Gráfico de acessos por dia">
        <div
          className="flex w-8 shrink-0 flex-col justify-between pb-6 text-right text-[10px] text-foreground-muted"
          aria-hidden="true"
        >
          <span>{axisMaximum}</span>
          <span>{middleTick}</span>
          <span>0</span>
        </div>
        <div className="relative grid min-w-0 flex-1 grid-cols-[repeat(30,minmax(0,1fr))] items-end gap-px border-b border-l border-border pb-6 sm:gap-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-border/60" />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-border/60" />
          {data.map((point, index) => {
            const selectedBar = point.date === selected?.date;
            const showLabel = index === 0 || index === data.length - 1 || index % 7 === 0;
            const height = point.views === 0 ? 2 : Math.max(4, (point.views / maximum) * 100);

            return (
              <button
                key={point.date}
                type="button"
                aria-label={`${formatDate(point.date, true)}: ${point.views} ${point.views === 1 ? "acesso" : "acessos"}`}
                aria-pressed={selectedBar}
                onClick={() => setSelectedDate(point.date)}
                onFocus={() => setSelectedDate(point.date)}
                onMouseEnter={() => setSelectedDate(point.date)}
                className="group relative z-10 flex h-full min-w-0 cursor-pointer items-end rounded-t-sm focus-visible:z-20"
              >
                <span
                  className={`block w-full min-w-[2px] rounded-t-sm transition-colors ${
                    selectedBar ? "bg-accent" : "bg-primary group-hover:bg-primary-hover"
                  }`}
                  style={{ height: `${height}%` }}
                  aria-hidden="true"
                />
                {showLabel && (
                  <span className="absolute top-full mt-1 whitespace-nowrap text-[9px] text-foreground-muted max-sm:hidden">
                    {formatDate(point.date)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-foreground-muted">Data</p>
    </div>
  );
}

export function SiteAccessCard({
  value,
  data,
}: {
  value: number;
  data: DailySiteAccessStat[] | null;
}) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block w-full cursor-pointer text-left">
        <Card className="h-full p-4 transition-colors hover:border-primary focus-within:border-primary">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
            Acessos ao site
          </p>
          <p className="mt-1.5 text-2xl font-semibold text-foreground">{value}</p>
          <p className="mt-1 text-xs font-medium text-primary">Ver detalhes</p>
        </Card>
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Acessos ao site"
        descriptionId={descriptionId}
        size="wide"
      >
        <p id={descriptionId} className="mb-5 text-sm text-foreground-muted">
          Acessos registrados nos últimos 30 dias
        </p>
        {data ? (
          <SiteAccessChart data={data} />
        ) : (
          <div role="alert" className="rounded-lg bg-danger-bg p-4 text-sm text-danger">
            Não foi possível carregar os acessos. Feche e tente novamente ao recarregar a página.
          </div>
        )}
      </Sheet>
    </>
  );
}
