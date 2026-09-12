"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { adminLogoutAction } from "@/app/admin/actions";

const LINKS = [
  { href: "/admin/dashboard", label: "Painel" },
  { href: "/admin/candidatos", label: "Candidatos" },
  { href: "/admin/cronograma", label: "Cronograma" },
  { href: "/admin/votacao", label: "Votação" },
  { href: "/admin/resultados", label: "Resultados" },
  { href: "/admin/desempates", label: "Desempates" },
  { href: "/admin/seguranca", label: "Segurança" },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="space-y-1">
      {LINKS.map((link) => {
        const active = pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`block rounded-md px-3 py-2.5 text-sm font-medium ${
              active
                ? "bg-primary/10 text-primary"
                : "text-foreground-muted hover:bg-surface-muted hover:text-foreground"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AdminSidebar() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-surface px-4 py-3 lg:hidden">
        <span className="text-sm font-semibold text-foreground">Administração</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Fechar menu" : "Abrir menu"}
          className="rounded-md p-2 text-foreground"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {open && (
        <div className="border-b border-border bg-surface px-4 py-3 lg:hidden">
          <NavLinks onNavigate={() => setOpen(false)} />
          <form action={adminLogoutAction} className="mt-2 border-t border-border pt-2">
            <button type="submit" className="block w-full rounded-md px-3 py-2.5 text-left text-sm font-medium text-danger">
              Sair
            </button>
          </form>
        </div>
      )}

      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface p-4 lg:flex lg:flex-col lg:justify-between">
        <div>
          <p className="px-3 pb-4 text-sm font-semibold text-foreground">Administração</p>
          <NavLinks />
        </div>
        <form action={adminLogoutAction}>
          <button
            type="submit"
            className="block w-full rounded-md px-3 py-2.5 text-left text-sm font-medium text-danger hover:bg-danger-bg"
          >
            Sair
          </button>
        </form>
      </aside>
    </>
  );
}
