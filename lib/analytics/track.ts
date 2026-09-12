import "server-only";
import { after } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Contagem agregada de acessos por página/dia (seção 70) — sem
 * rastreamento individual.
 *
 * Roda em `after()`: o Next executa o callback depois que a resposta é
 * enviada, então a escrita não entra no TTFB. Antes, a chamada era
 * disparada (sem await) durante o render — o que ainda competia com a
 * renderização e podia ser cortada pelo fim da invocação serverless.
 * Falha em analytics nunca pode quebrar a página.
 */
export function trackPageView(path: string): void {
  after(async () => {
    try {
      const supabase = createServiceClient();
      const { error } = await supabase.rpc("increment_page_view", { p_path: path });
      if (error) console.error("trackPageView failed", error);
    } catch (err) {
      console.error("trackPageView failed", err);
    }
  });
}
