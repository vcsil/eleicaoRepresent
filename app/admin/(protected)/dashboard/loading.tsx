import { Skeleton, MetricCardSkeleton } from "@/components/feedback/Skeleton";

/** Espelha a grade de 12 métricas + o card de acessos do painel. */
export default function Loading() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-foreground">Painel</h1>
      <Skeleton className="mt-1.5 h-4 w-56" />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" role="status" aria-label="Carregando">
        {Array.from({ length: 4 }, (_, i) => (
          <MetricCardSkeleton key={`a${i}`} />
        ))}
        {/* Card de acessos: ocupa a mesma caixa alta do gráfico real. */}
        <div className="rounded-lg border border-border bg-surface p-4 sm:col-span-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="mt-2.5 h-7 w-24" />
          <Skeleton className="mt-3 h-24 w-full" />
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <MetricCardSkeleton key={`b${i}`} />
        ))}
      </div>
    </div>
  );
}
