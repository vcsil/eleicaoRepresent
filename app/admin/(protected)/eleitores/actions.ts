"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdminSession } from "@/lib/admin/session";
import { logAdminAction } from "@/lib/admin/audit-log";
import { getExistingRegistrations } from "@/lib/admin/voters";
import { getMainElection, getElectionStatus, isVotingOpen } from "@/lib/election/status";
import { parseVotersFile, FileParseError } from "@/lib/voters/parse-file";
import { validateRows, type ColumnMapping } from "@/lib/voters/validate-import";

export type ImportVotersState = {
  error: string | null;
  result?: { inserted: number; updated: number; votingWasOpen: boolean };
};

/**
 * Importa a lista de eleitores a partir do arquivo enviado.
 *
 * O arquivo é REPARSEADO aqui. A pré-visualização do navegador serve à
 * interface, nunca como insumo da gravação: o que vale é o que o servidor
 * lê do arquivo original.
 *
 * O arquivo não é armazenado em lugar nenhum — é processado em memória e
 * descartado. Fórmulas e macros não são avaliadas; a planilha é tratada
 * apenas como dados.
 */
export async function importVotersAction(
  _prevState: ImportVotersState,
  formData: FormData,
): Promise<ImportVotersState> {
  await requireAdminSession();

  const file = formData.get("file");
  const sheetName = formData.get("sheet_name");
  const registrationIndex = Number(formData.get("registration_index"));
  const nameIndex = Number(formData.get("name_index"));
  const confirmedVotingOpen = formData.get("confirm_voting_open") === "1";

  if (!(file instanceof File)) {
    return { error: "Nenhum arquivo enviado." };
  }
  if (!Number.isInteger(registrationIndex) || !Number.isInteger(nameIndex)) {
    return { error: "Selecione as colunas de matrícula e de nome." };
  }
  if (registrationIndex === nameIndex) {
    return { error: "Matrícula e nome não podem ser a mesma coluna." };
  }

  // Votação aberta não bloqueia, mas exige confirmação explícita — e a
  // confirmação é revalidada AQUI, não só na tela: importar eleitor com a
  // urna aberta muda o total de habilitados e, portanto, o percentual de
  // participação do pleito em curso.
  const election = await getMainElection();
  const votingOpen = election ? isVotingOpen(await getElectionStatus(election.id)) : false;
  if (votingOpen && !confirmedVotingOpen) {
    return {
      error:
        "A votação está aberta. Confirme que deseja alterar a lista de eleitores durante o pleito.",
    };
  }

  let workbook;
  try {
    workbook = await parseVotersFile(file);
  } catch (error) {
    if (error instanceof FileParseError) return { error: error.message };
    console.error("parseVotersFile failed", error);
    return { error: "Não foi possível ler o arquivo enviado." };
  }

  const sheet =
    workbook.sheets.find((s) => s.name === sheetName) ??
    (workbook.sheets.length === 1 ? workbook.sheets[0] : null);

  if (!sheet) {
    return { error: "Selecione qual aba da planilha deve ser importada." };
  }

  const mapping: ColumnMapping = { registrationIndex, nameIndex };
  if (
    registrationIndex >= sheet.header.length ||
    nameIndex >= sheet.header.length ||
    registrationIndex < 0 ||
    nameIndex < 0
  ) {
    return { error: "As colunas selecionadas não existem nesta planilha." };
  }

  // Primeira passada só para saber quais matrículas já existem.
  const preliminary = validateRows(sheet, mapping);
  const existing = await getExistingRegistrations(
    preliminary.importable.map((r) => r.registration_number),
  );
  const validation = validateRows(sheet, mapping, existing);

  if (validation.blocking.length > 0) {
    return { error: validation.blocking[0] };
  }
  if (validation.importable.length === 0) {
    return { error: "Nenhuma linha válida para importar." };
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("import_voters", {
    p_rows: validation.importable,
    p_mode: "update_existing",
  });

  if (error) {
    const code = error.message.trim();
    if (code === "TOO_MANY_ROWS") return { error: "O arquivo tem linhas demais." };
    if (code === "EMPTY_PAYLOAD" || code === "NO_VALID_ROWS") {
      return { error: "Nenhuma linha válida para importar." };
    }
    console.error("import_voters failed", error);
    return { error: "Não foi possível importar os eleitores. Tente novamente." };
  }

  const counts = (data ?? {}) as { inserted?: number; updated?: number };
  const inserted = Number(counts.inserted ?? 0);
  const updated = Number(counts.updated ?? 0);

  // Metadados apenas — o conteúdo da planilha nunca vai para o log.
  await logAdminAction("VOTERS_IMPORTED", {
    inserted,
    updated,
    file_type: workbook.kind,
    file_name: file.name,
    during_open_voting: votingOpen,
  });

  revalidatePath("/admin/eleitores");
  // O painel mostra "Eleitores habilitados"; nenhuma tag de votação ou de
  // candidatos é afetada — `voters` não é cacheada.
  revalidatePath("/admin/dashboard");

  return { error: null, result: { inserted, updated, votingWasOpen: votingOpen } };
}
