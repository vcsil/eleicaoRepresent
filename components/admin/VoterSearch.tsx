"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { buildVoterParams } from "@/lib/admin/voters-params";

const DEBOUNCE_MS = 300;

/**
 * Barra de pesquisa. O estado real vive na URL — este componente só a
 * reescreve; quem busca continua sendo o Server Component da página.
 *
 * Envolve um <form> de verdade para funcionar sem JavaScript e para o Enter
 * submeter na hora, sem esperar o debounce.
 */
export function VoterSearch({ initialQuery }: { initialQuery: string }) {
  const [value, setValue] = useState(initialQuery);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const primeiroRender = useRef(true);

  // Ressincroniza quando a URL muda POR FORA (voltar/avançar do navegador).
  // Ajuste durante o render — o padrão que o React documenta para "resetar
  // estado quando uma prop muda". Num efeito isso renderizaria uma vez com o
  // valor velho e é justamente o que `react-hooks/set-state-in-effect` barra.
  const [queryAnterior, setQueryAnterior] = useState(initialQuery);
  if (queryAnterior !== initialQuery) {
    setQueryAnterior(initialQuery);
    setValue(initialQuery);
  }

  useEffect(() => {
    if (primeiroRender.current) {
      primeiroRender.current = false;
      return;
    }
    if (value === initialQuery) return;

    const id = setTimeout(() => {
      // buildVoterParams já derruba `page`: pesquisa nova recomeça na 1.
      const params = buildVoterParams(searchParams.toString(), { q: value });
      startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
    }, DEBOUNCE_MS);

    return () => clearTimeout(id);
  }, [value, initialQuery, pathname, router, searchParams]);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const params = buildVoterParams(searchParams.toString(), { q: value });
        router.replace(`${pathname}?${params}`, { scroll: false });
      }}
    >
      <label htmlFor="voter-search" className="sr-only">
        Pesquisar eleitores
      </label>
      <input
        id="voter-search"
        name="q"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Pesquisar por matrícula ou nome"
        className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      />
    </form>
  );
}
