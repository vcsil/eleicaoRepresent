import { Skeleton, MetricCardSkeleton } from "@/components/feedback/Skeleton";

export default function Loading() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-foreground">Votação</h1>

      <div className="mt-6 grid gap-4 sm:grid-cols-2" role="status" aria-label="Carregando">
        <MetricCardSkeleton />
        <MetricCardSkeleton />
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-semibold text-foreground">Ações</h2>
        <Skeleton className="mt-2 h-4 w-full max-w-md" />
        <div className="mt-4 flex flex-wrap gap-3">
          <Skeleton className="h-10 w-40 rounded-md" />
          <Skeleton className="h-10 w-36 rounded-md" />
        </div>
      </div>
    </div>
  );
}
