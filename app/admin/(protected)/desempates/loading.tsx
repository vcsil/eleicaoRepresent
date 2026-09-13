import { Skeleton } from "@/components/feedback/Skeleton";

export default function Loading() {
  return (
    <div className="max-w-2xl" role="status" aria-label="Carregando">
      <h1 className="text-2xl font-semibold text-foreground">Desempates e pendências</h1>

      {["Candidatos eleitos em dois cargos", "Empates pendentes", "Votações de desempate criadas"].map(
        (titulo, i) => (
          <section key={titulo} className={i === 0 ? "mt-8" : "mt-10"}>
            <h2 className="text-sm font-semibold text-foreground">{titulo}</h2>
            <div className="mt-3 space-y-2">
              {Array.from({ length: 2 }, (_, j) => (
                <div key={j} className="rounded-lg border border-border bg-surface p-3">
                  <div className="flex items-start justify-between gap-3">
                    <Skeleton className="h-4 w-full max-w-[12rem]" />
                    <Skeleton className="h-5 w-24 shrink-0 rounded-full" />
                  </div>
                  <Skeleton className="mt-3 h-3 w-40" />
                </div>
              ))}
            </div>
          </section>
        ),
      )}
    </div>
  );
}
