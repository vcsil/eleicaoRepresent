import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/admin/session";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { AdminIdleSessionProvider } from "@/components/admin/AdminIdleSessionProvider";

export default async function AdminProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session) {
    redirect("/admin");
  }

  return (
    <AdminIdleSessionProvider initialExpiresAt={session.expiresAt.toISOString()}>
      <div className="flex min-h-screen flex-col lg:flex-row">
        <AdminSidebar />
        <main className="flex-1 px-4 py-8 sm:px-6 lg:px-10">{children}</main>
      </div>
    </AdminIdleSessionProvider>
  );
}
