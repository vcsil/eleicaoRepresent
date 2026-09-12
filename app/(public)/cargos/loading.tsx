import { CardGridSkeleton } from "@/components/feedback/Skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <header className="mb-10 text-center">
        <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">Cargos da Comissão</h1>
        <p className="mx-auto mt-3 max-w-2xl text-foreground-muted">
          A Comissão de Formatura terá 13 integrantes distribuídos em 6 cargos. Toque em um cargo
          para ver atribuições e o perfil desejado.
        </p>
      </header>

      <CardGridSkeleton count={6} />
    </div>
  );
}
