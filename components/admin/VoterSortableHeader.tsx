"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { VoterSort, SortDirection } from "@/lib/admin/voters-values";
import { buildVoterParams, nextSortDirection } from "@/lib/admin/voters-params";

/**
 * Cabeçalho de coluna clicável.
 *
 * É um <Link>, não um <button>: navegação por teclado, "abrir em nova aba" e
 * o estado na URL saem de graça. `aria-sort` no <th> anuncia a direção ativa.
 */
export function VoterSortableHeader({
  label,
  sort,
  currentSort,
  currentDirection,
  className = "",
}: {
  label: string;
  sort: VoterSort;
  currentSort: VoterSort;
  currentDirection: SortDirection;
  className?: string;
}) {
  const searchParams = useSearchParams();
  const ativo = currentSort === sort;
  const proximaDirecao = nextSortDirection(sort, currentSort, currentDirection);
  // Reordenar volta para a página 1 — buildVoterParams cuida disso.
  const params = buildVoterParams(searchParams.toString(), { sort, dir: proximaDirecao });

  return (
    <th
      scope="col"
      className={`px-4 py-2.5 ${className}`}
      aria-sort={ativo ? (currentDirection === "asc" ? "ascending" : "descending") : "none"}
    >
      <Link
        href={`?${params}`}
        scroll={false}
        className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {label}
        <span aria-hidden="true" className={ativo ? "text-foreground" : "opacity-40"}>
          {ativo ? (currentDirection === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </Link>
    </th>
  );
}
