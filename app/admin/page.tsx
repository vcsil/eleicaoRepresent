import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/admin/session";
import { AdminLoginForm } from "@/components/admin/AdminLoginForm";

export const metadata: Metadata = { title: "Administração" };
export const dynamic = "force-dynamic";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const session = await getAdminSession();
  if (session) {
    redirect("/admin/dashboard");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-xl font-semibold text-foreground">
          Administração da eleição
        </h1>
        <p className="mt-2 text-center text-sm text-foreground-muted">
          Comissão de Formatura — Turma 36
        </p>
        <div className="mt-8 rounded-lg border border-border bg-surface p-6 shadow-sm">
          <AdminLoginForm expired={(await searchParams).reason === "expired"} />
        </div>
      </div>
    </div>
  );
}
