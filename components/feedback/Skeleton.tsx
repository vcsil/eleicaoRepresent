/**
 * Bloco de placeholder com a mesma caixa do conteúdo real, para o layout
 * não saltar quando os dados chegam. Só deve ser usado onde a espera é
 * real (cache miss//dados dinâmicos) — nunca para simular carregamento.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-muted ${className}`} aria-hidden="true" />;
}

/** Card de candidato/cargo em estado de carregamento. */
export function CardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col items-center">
        <Skeleton className="h-[72px] w-[72px] rounded-full" />
        <Skeleton className="mt-3 h-4 w-32" />
        <Skeleton className="mt-2 h-5 w-24 rounded-full" />
      </div>
    </div>
  );
}

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Carregando">
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}
