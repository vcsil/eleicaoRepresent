"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { buildVoterParams } from "@/lib/admin/voters-params";

export function VoterPagination({ page, pageCount }: { page: number; pageCount: number }) {
  const searchParams = useSearchParams();

  function href(destino: number) {
    // Só a página muda: pesquisa e ordenação são preservadas.
    return `?${buildVoterParams(searchParams.toString(), { page: destino })}`;
  }

  const temAnterior = page > 1;
  const temProxima = page < pageCount;

  // Desabilitado vira <span>, não <Link>: um link inerte confunde leitor de
  // tela e continua navegável por teclado.
  const base =
    "rounded-md border border-border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-3" aria-label="Paginação">
      <p className="text-sm text-foreground-muted" aria-live="polite">
        Página {page} de {pageCount}
      </p>
      <div className="flex shrink-0 gap-2">
        {temAnterior ? (
          <Link href={href(page - 1)} scroll={false} className={`${base} text-foreground`}>
            Anterior
          </Link>
        ) : (
          <span className={`${base} text-foreground-muted opacity-50`} aria-disabled="true">
            Anterior
          </span>
        )}
        {temProxima ? (
          <Link href={href(page + 1)} scroll={false} className={`${base} text-foreground`}>
            Próxima
          </Link>
        ) : (
          <span className={`${base} text-foreground-muted opacity-50`} aria-disabled="true">
            Próxima
          </span>
        )}
      </div>
    </nav>
  );
}
