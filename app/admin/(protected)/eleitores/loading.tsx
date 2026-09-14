import { Skeleton, RowsSkeleton } from "@/components/feedback/Skeleton";

export default function Loading() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-foreground">Eleitores</h1>
      <Skeleton className="mt-2 h-4 w-80" />

      <div className="mt-6 rounded-lg border border-border bg-surface p-4" role="status" aria-label="Carregando">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-10 w-full rounded-md" />
        <Skeleton className="mt-3 h-10 w-44 rounded-md" />
      </div>

      <section className="mt-12">
        <h2 className="text-sm font-semibold text-foreground">Lista atual</h2>
        {/* Barra de pesquisa, tabela e paginação nas mesmas caixas do real. */}
        <Skeleton className="mt-3 h-10 w-full rounded-md" />
        <div className="mt-3">
          <RowsSkeleton rows={8} withBadge />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-5 w-28" />
          <span className="flex shrink-0 gap-2">
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </span>
        </div>
      </section>
    </div>
  );
}
