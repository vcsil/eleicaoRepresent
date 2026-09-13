import { Skeleton, RowsSkeleton } from "@/components/feedback/Skeleton";

export default function Loading() {
  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-foreground">Candidatos</h1>
        <Skeleton className="h-10 w-36 rounded-md" />
      </div>

      <div className="mt-6" role="status" aria-label="Carregando">
        <RowsSkeleton rows={6} withBadge />
      </div>
    </div>
  );
}
