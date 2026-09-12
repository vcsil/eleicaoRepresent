import type { Metadata } from "next";
import { getRecentSecurityEvents, getRecentAdminLogs } from "@/lib/admin/security-log";
import { SecurityEventTable } from "@/components/admin/SecurityEventTable";
import { ActivityTable } from "@/components/admin/ActivityTable";

export const metadata: Metadata = { title: "Segurança — Administração" };
export const dynamic = "force-dynamic";

export default async function AdminSegurancaPage() {
  const [events, logs] = await Promise.all([getRecentSecurityEvents(), getRecentAdminLogs()]);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-foreground">Segurança</h1>

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-foreground">Eventos de segurança recentes</h2>
        <div className="mt-3">
          <SecurityEventTable events={events} />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold text-foreground">Registro de ações administrativas</h2>
        <div className="mt-3">
          <ActivityTable logs={logs} />
        </div>
      </section>
    </div>
  );
}
