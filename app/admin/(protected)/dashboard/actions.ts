"use server";

import { revalidatePath, updateTag } from "next/cache";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { logAdminAction } from "@/lib/admin/audit-log";
import { requireAdminSession } from "@/lib/admin/session";

export type InvalidateCacheState = { error: string | null; success?: boolean };

/**
 * Invalida todas as tags do Data Cache de uma vez.
 *
 * Existe por causa de uma limitação real do desenho: com
 * `revalidate: false`, o cache só expira quando uma Server Action deste
 * app invalida a tag. Alteração feita DIRETO no banco (SQL Editor do
 * Supabase, `psql`) não passa por nenhuma action — e o site continuaria
 * servindo o valor antigo indefinidamente. Este é o escape manual.
 *
 * Itera sobre `CACHE_TAGS` em vez de listar as tags à mão: tag nova
 * criada no futuro entra aqui automaticamente, sem ninguém precisar
 * lembrar.
 *
 * Não toca em nada autoritativo — status da eleição, votos, sessões e
 * validação de eleitor nunca foram cacheados, então não há o que
 * invalidar neles e esta ação não tem como afetar a segurança do pleito.
 */
export async function invalidateAllCachesAction(): Promise<InvalidateCacheState> {
  await requireAdminSession();
  const tags = Object.values(CACHE_TAGS);
  for (const tag of tags) {
    updateTag(tag);
  }

  await logAdminAction("CACHE_INVALIDATED", { tags });

  revalidatePath("/", "layout");
  return { error: null, success: true };
}
