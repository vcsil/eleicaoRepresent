import { Skeleton, RowsSkeleton } from "@/components/feedback/Skeleton";

/** Cargo + linhas de candidato com votos e badge, sem números fictícios. */
export default function Loading() {
  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-foreground">Resultados (visão interna)</h1>
        <Skeleton className="h-10 w-40 rounded-md" />
      </div>
      <Skeleton className="mt-2 h-4 w-64" />

      <div className="mt-6 space-y-6" role="status" aria-label="Carregando">
        {Array.from({ length: 3 }, (_, i) => (
          <section key={i}>
            <Skeleton className="mb-2 h-5 w-40" />
            <RowsSkeleton rows={3} withBadge />
          </section>
        ))}
      </div>
    </div>
  );
}
