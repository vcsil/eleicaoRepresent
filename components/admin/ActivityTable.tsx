import { EmptyState } from "@/components/feedback/EmptyState";
import type { AdminLogRow } from "@/lib/admin/security-log";

export function ActivityTable({ logs }: { logs: AdminLogRow[] }) {
  if (logs.length === 0) {
    return <EmptyState title="Nenhuma ação administrativa registrada" />;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface-muted text-xs uppercase text-foreground-muted">
          <tr>
            <th className="px-4 py-2.5">Ação</th>
            <th className="px-4 py-2.5">Autor</th>
            <th className="px-4 py-2.5">Quando</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-surface">
          {logs.map((log) => (
            <tr key={log.id}>
              <td className="px-4 py-2.5 font-medium text-foreground">{log.action}</td>
              <td className="px-4 py-2.5 text-foreground-muted">{log.actor}</td>
              <td className="px-4 py-2.5 text-foreground-muted">
                {new Date(log.created_at).toLocaleString("pt-BR")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
