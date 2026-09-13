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

/**
 * Peças do painel administrativo.
 *
 * Mesma linguagem visual dos skeletons públicos (animate-pulse +
 * bg-surface-muted): o objetivo é aproximar a CAIXA do conteúdo real para o
 * layout não saltar quando os dados chegam — nunca simular valores.
 */
export function MetricCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <Skeleton className="h-3 w-28" />
      <Skeleton className="mt-2.5 h-7 w-20" />
    </div>
  );
}

export function MetricGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div
      className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      role="status"
      aria-label="Carregando"
    >
      {Array.from({ length: count }, (_, i) => (
        <MetricCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** Linhas de lista/tabela — cargos com candidatos, eleitores, candidatos. */
export function RowsSkeleton({ rows = 5, withBadge = false }: { rows?: number; withBadge?: boolean }) {
  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-surface">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-3 p-3">
          <Skeleton className="h-4 w-full max-w-[14rem]" />
          <span className="flex shrink-0 items-center gap-2">
            <Skeleton className="h-4 w-16" />
            {withBadge && <Skeleton className="h-5 w-16 rounded-full" />}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Cabeçalho padrão das telas do painel: título real, subtítulo em placeholder. */
export function AdminPageSkeleton({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      <Skeleton className="mt-2 h-4 w-48" />
      {children}
    </div>
  );
}
