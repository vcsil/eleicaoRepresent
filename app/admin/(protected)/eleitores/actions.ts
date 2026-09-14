"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdminSession } from "@/lib/admin/session";
import { logAdminAction } from "@/lib/admin/audit-log";
import { getExistingRegistrations } from "@/lib/admin/voters";
import { z } from "zod";
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

export type VoterMutationState = { error: string | null; success?: string };

const voterIdSchema = z.string().uuid();

/** Votação aberta muda o denominador da participação — vale para as duas ações. */
async function votingIsOpen(): Promise<boolean> {
  const election = await getMainElection();
  return election ? isVotingOpen(await getElectionStatus(election.id)) : false;
}

/**
 * Exclui um eleitor do cadastro.
 *
 * Quem já votou NUNCA é excluído: `audit_vote_links.voter_id` referencia
 * `voters(id)` sem ON DELETE CASCADE (0002_schema.sql:237), então o próprio
 * Postgres recusa o DELETE. A checagem abaixo existe para dar mensagem
 * amigável; a violação de FK é a rede de segurança para a corrida (alguém
 * vota entre a checagem e o DELETE). Em nenhum caminho apagamos ballot,
 * ballot_choices ou audit_vote_links para "liberar" a exclusão.
 *
 * `vote_sessions.voter_id` É cascade (0002_schema.sql:190): sessões pendentes
 * de quem nunca votou saem junto, que é o comportamento correto — um token
 * de urna sem eleitor não pode continuar válido.
 */
export async function deleteVoterAction(
  _prevState: VoterMutationState,
  formData: FormData,
): Promise<VoterMutationState> {
  await requireAdminSession();

  const parsed = voterIdSchema.safeParse(formData.get("voter_id"));
  if (!parsed.success) return { error: "Eleitor inválido." };
  const voterId = parsed.data;
  const confirmedVotingOpen = formData.get("confirm_voting_open") === "1";

  const supabase = createServiceClient();
  const { data: voter, error: readError } = await supabase
    .from("voters")
    .select("id, registration_number")
    .eq("id", voterId)
    .maybeSingle();

  if (readError) {
    console.error("deleteVoterAction read failed", readError);
    return { error: "Não foi possível excluir o eleitor." };
  }
  // Dupla submissão: a segunda não acha mais a linha e termina sem erro.
  if (!voter) return { error: null, success: "Eleitor já havia sido excluído." };

  // Mesma regra da importação, revalidada AQUI e não só na tela: excluir
  // durante o pleito muda o total de habilitados e o percentual de
  // participação.
  const votingOpen = await votingIsOpen();
  if (votingOpen && !confirmedVotingOpen) {
    return {
      error:
        "A votação está aberta. Confirme que deseja alterar a lista de eleitores durante o pleito.",
    };
  }

  const { count, error: linkError } = await supabase
    .from("audit_vote_links")
    .select("id", { count: "exact", head: true })
    .eq("voter_id", voterId);

  if (linkError) {
    console.error("deleteVoterAction audit check failed", linkError);
    return { error: "Não foi possível excluir o eleitor." };
  }
  if ((count ?? 0) > 0) {
    return {
      error:
        "Este eleitor possui participação eleitoral registrada e não pode ser excluído. Inative o cadastro em vez disso.",
    };
  }

  const { error } = await supabase.from("voters").delete().eq("id", voterId);

  if (error) {
    // 23503 = foreign_key_violation: alguém votou entre a checagem e agora.
    if (error.code === "23503") {
      return {
        error:
          "Este eleitor possui participação eleitoral registrada e não pode ser excluído. Inative o cadastro em vez disso.",
      };
    }
    console.error("deleteVoterAction failed", error);
    return { error: "Não foi possível excluir o eleitor." };
  }

  // Sem nome completo no log: matrícula já identifica o registro.
  await logAdminAction("VOTER_DELETED", {
    voterId,
    registration_number: voter.registration_number,
    during_open_voting: votingOpen,
  });

  revalidatePath("/admin/eleitores");
  revalidatePath("/admin/dashboard");

  return { error: null, success: "Eleitor excluído." };
}

/**
 * Ativa ou inativa um eleitor.
 *
 * É a saída para quem já votou e por isso não pode ser excluído — sem ela, a
 * mensagem de recusa da exclusão apontaria para algo que não existe. Um
 * eleitor inativo é recusado por `validate_voter` (0004_voting_functions.sql)
 * e sai do denominador da participação, mas o histórico dele permanece.
 */
export async function setVoterActiveAction(
  _prevState: VoterMutationState,
  formData: FormData,
): Promise<VoterMutationState> {
  await requireAdminSession();

  const parsed = voterIdSchema.safeParse(formData.get("voter_id"));
  if (!parsed.success) return { error: "Eleitor inválido." };
  const voterId = parsed.data;
  const active = formData.get("active") === "1";
  const confirmedVotingOpen = formData.get("confirm_voting_open") === "1";

  const votingOpen = await votingIsOpen();
  if (votingOpen && !confirmedVotingOpen) {
    return {
      error:
        "A votação está aberta. Confirme que deseja alterar a lista de eleitores durante o pleito.",
    };
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("voters")
    .update({ active })
    .eq("id", voterId)
    .select("registration_number")
    .maybeSingle();

  if (error) {
    console.error("setVoterActiveAction failed", error);
    return { error: "Não foi possível alterar a situação do eleitor." };
  }
  if (!data) return { error: "Eleitor não encontrado." };

  await logAdminAction(active ? "VOTER_ACTIVATED" : "VOTER_DEACTIVATED", {
    voterId,
    registration_number: data.registration_number,
    during_open_voting: votingOpen,
  });

  revalidatePath("/admin/eleitores");
  revalidatePath("/admin/dashboard");

  return { error: null, success: active ? "Eleitor ativado." : "Eleitor inativado." };
}
