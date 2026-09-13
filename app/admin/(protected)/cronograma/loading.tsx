import { Skeleton } from "@/components/feedback/Skeleton";

/** As 8 fases do cronograma, com a mesma grade responsiva do formulário real. */
export default function Loading() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-foreground">Cronograma</h1>
      <Skeleton className="mt-2 h-4 w-72" />

      <div className="mt-6 space-y-4" role="status" aria-label="Carregando">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-4">
            <Skeleton className="h-5 w-48" />
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, j) => (
                <div key={j} className="min-w-0">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="mt-1 h-9 w-full rounded-md" />
                </div>
              ))}
            </div>
            <Skeleton className="mt-3 h-9 w-24 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
