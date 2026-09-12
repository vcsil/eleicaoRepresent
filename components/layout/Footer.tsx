import Link from "next/link";

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-foreground-muted sm:px-6">
        <p>
          Comissão de Formatura — Turma 36 de Medicina, Universidade Evangélica de Goiás
          (UniEVANGÉLICA).
        </p>
        <nav className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Links institucionais">
          <Link href="/" className="hover:text-foreground">
            Início
          </Link>
          <Link href="/cargos" className="hover:text-foreground">
            Cargos
          </Link>
          <Link href="/candidatos" className="hover:text-foreground">
            Candidatos
          </Link>
          <Link href="/resultados" className="hover:text-foreground">
            Resultados
          </Link>
          <Link href="/admin" className="hover:text-foreground">
            Administração
          </Link>
        </nav>
      </div>
    </footer>
  );
}
