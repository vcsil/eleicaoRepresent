import { Skeleton, CardGridSkeleton } from "@/components/feedback/Skeleton";

/**
 * Mantém título, subtítulo e barra de filtros no lugar definitivo — só a
 * grade de candidatos aparece como placeholder. Evita a sequência
 * "tela vazia → spinner → página".
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <header className="mb-10 text-center">
        <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">Candidatos</h1>
        <p className="mx-auto mt-3 max-w-2xl text-foreground-muted">
          Conheça quem está concorrendo a cada cargo da Comissão de Formatura. Toque em um
          candidato para ver apresentação, propostas e vídeo.
        </p>
      </header>

      <div className="mb-8 flex flex-wrap justify-center gap-2">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-24 rounded-full" />
        ))}
      </div>

      <CardGridSkeleton count={6} />
    </div>
  );
}
