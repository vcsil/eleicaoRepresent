import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/feedback/EmptyState";
import type { SecurityEventRow } from "@/lib/admin/security-log";

const SEVERITY_TONE = {
  info: "neutral",
  warning: "warning",
  critical: "danger",
} as const;

export function SecurityEventTable({ events }: { events: SecurityEventRow[] }) {
  if (events.length === 0) {
    return <EmptyState title="Nenhum evento de segurança registrado" />;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface-muted text-xs uppercase text-foreground-muted">
          <tr>
            <th className="px-4 py-2.5">Tipo</th>
            <th className="px-4 py-2.5">Severidade</th>
            <th className="px-4 py-2.5">Rota</th>
            <th className="px-4 py-2.5">Quando</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-surface">
          {events.map((event) => (
            <tr key={event.id}>
              <td className="px-4 py-2.5 font-medium text-foreground">{event.type}</td>
              <td className="px-4 py-2.5">
                <Badge tone={SEVERITY_TONE[event.severity as keyof typeof SEVERITY_TONE] ?? "neutral"}>
                  {event.severity}
                </Badge>
              </td>
              <td className="px-4 py-2.5 text-foreground-muted">{event.route ?? "—"}</td>
              <td className="px-4 py-2.5 text-foreground-muted">
                {new Date(event.created_at).toLocaleString("pt-BR")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
