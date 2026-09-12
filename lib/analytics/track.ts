import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Contagem agregada de acessos por página/dia (seção 70) — sem
 * rastreamento individual. Fire-and-forget: nunca deve atrasar ou quebrar
 * a renderização da página.
 */
export function trackPageView(path: string): void {
  const supabase = createServiceClient();
  supabase
    .rpc("increment_page_view", { p_path: path })
    .then(({ error }) => {
      if (error) console.error("trackPageView failed", error);
    });
}
