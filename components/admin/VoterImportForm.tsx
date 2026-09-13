"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";
import {
  parseVotersFile,
  FileParseError,
  type ParsedWorkbook,
  type SheetTable,
} from "@/lib/voters/parse-file";
import {
  detectColumns,
  validateRows,
  type ColumnMapping,
  type ValidationResult,
  type RowStatus,
} from "@/lib/voters/validate-import";
import {
  importVotersAction,
  type ImportVotersState,
} from "@/app/admin/(protected)/eleitores/actions";

const initialState: ImportVotersState = { error: null };

const selectClass =
  "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

const STATUS_LABEL: Record<RowStatus, string> = {
  new: "Novo",
  existing: "Já cadastrado",
  missing_registration: "Matrícula ausente",
  missing_name: "Nome ausente",
  duplicate_in_file: "Duplicado no arquivo",
};

const STATUS_TONE: Record<RowStatus, "success" | "info" | "warning" | "neutral"> = {
  new: "success",
  existing: "info",
  missing_registration: "warning",
  missing_name: "warning",
  duplicate_in_file: "warning",
};

/**
 * Importação de eleitores em três passos: selecionar → conferir → confirmar.
 *
 * A pré-visualização roda no navegador só para dar resposta imediata. O
 * arquivo original vai inteiro para a Server Action, que o relê e revalida
 * — nada aqui é fonte de verdade.
 */
export function VoterImportForm({ votingOpen }: { votingOpen: boolean }) {
  const [state, formAction, isPending] = useActionState(importVotersAction, initialState);

  const [file, setFile] = useState<File | null>(null);
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [sheetName, setSheetName] = useState<string>("");
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [needsMapping, setNeedsMapping] = useState(false);
  const [preview, setPreview] = useState<ValidationResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function activeSheet(book: ParsedWorkbook, name: string): SheetTable | null {
    return book.sheets.find((s) => s.name === name) ?? null;
  }

  function runPreview(book: ParsedWorkbook, name: string, columns: ColumnMapping | null) {
    const sheet = activeSheet(book, name);
    if (!sheet || !columns) {
      setPreview(null);
      return;
    }
    // Sem o mapa de existentes: o navegador não consulta o banco. Quem
    // distingue "novo" de "já cadastrado" de verdade é o servidor.
    setPreview(validateRows(sheet, columns));
  }

  async function handleFile(selected: File | null) {
    setFile(selected);
    setWorkbook(null);
    setPreview(null);
    setMapping(null);
    setNeedsMapping(false);
    setParseError(null);
    if (!selected) return;

    try {
      const book = await parseVotersFile(selected);
      const firstSheet = book.sheets[0];
      const detected = detectColumns(firstSheet.header);

      setWorkbook(book);
      setSheetName(firstSheet.name);
      setMapping(detected);
      setNeedsMapping(detected === null);
      runPreview(book, firstSheet.name, detected);
    } catch (error) {
      setParseError(
        error instanceof FileParseError ? error.message : "Não foi possível ler o arquivo.",
      );
    }
  }

  function handleSheetChange(name: string) {
    if (!workbook) return;
    setSheetName(name);
    const sheet = activeSheet(workbook, name);
    const detected = sheet ? detectColumns(sheet.header) : null;
    setMapping(detected);
    setNeedsMapping(detected === null);
    runPreview(workbook, name, detected);
  }

  function handleMappingChange(next: ColumnMapping) {
    setMapping(next);
    if (workbook) runPreview(workbook, sheetName, next);
  }

  const sheet = workbook ? activeSheet(workbook, sheetName) : null;
  const blocked = !preview || preview.blocking.length > 0 || preview.importable.length === 0;
  const canSubmit = Boolean(file && mapping && !blocked && !isPending);

  if (state.result) {
    const { inserted, updated, votingWasOpen } = state.result;
    return (
      <Card className="p-5">
        <p className="font-medium text-success">
          {inserted} {inserted === 1 ? "eleitor importado" : "eleitores importados"} com sucesso.
        </p>
        {updated > 0 && (
          <p className="mt-1 text-sm text-foreground-muted">
            {updated} {updated === 1 ? "já existente teve o nome atualizado" : "já existentes tiveram o nome atualizado"}.
          </p>
        )}
        {votingWasOpen && (
          <p className="mt-2 text-sm text-warning">
            A importação ocorreu com a votação aberta — o total de eleitores habilitados mudou
            durante o pleito.
          </p>
        )}
        <Button href="/admin/eleitores" variant="secondary" className="mt-4">
          Voltar à lista
        </Button>
      </Card>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="sheet_name" value={sheetName} />
      <input type="hidden" name="registration_index" value={mapping?.registrationIndex ?? ""} />
      <input type="hidden" name="name_index" value={mapping?.nameIndex ?? ""} />
      {votingOpen && <input type="hidden" name="confirm_voting_open" value="1" />}

      {votingOpen && (
        <p className="mb-4 rounded-md border border-warning bg-warning-bg px-3.5 py-3 text-sm text-warning">
          <strong>A votação está aberta.</strong> Importar eleitores agora altera o total de
          habilitados e, com ele, o percentual de participação do pleito em curso. A ação fica
          registrada no log administrativo.
        </p>
      )}

      <Card className="p-5">
        <label className="text-sm font-medium text-foreground" htmlFor="file">
          Arquivo (.csv ou .xlsx, até 2 MB)
        </label>
        <input
          id="file"
          type="file"
          name="file"
          accept=".csv,.xlsx"
          required
          onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
          className="mt-2 block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-foreground"
        />
        <p className="mt-2 text-xs text-foreground-muted">
          O arquivo precisa ter uma coluna de matrícula e uma de nome completo. Ele é lido,
          conferido e descartado — não fica armazenado.
        </p>
        {parseError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {parseError}
          </p>
        )}
      </Card>

      {workbook && workbook.sheets.length > 1 && (
        <Card className="mt-4 p-5">
          <label className="text-sm font-medium text-foreground" htmlFor="sheet">
            A planilha tem {workbook.sheets.length} abas. Qual deve ser importada?
          </label>
          <select
            id="sheet"
            value={sheetName}
            onChange={(e) => handleSheetChange(e.target.value)}
            className={selectClass}
          >
            {workbook.sheets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </Card>
      )}

      {sheet && needsMapping && (
        <Card className="mt-4 p-5">
          <p className="text-sm font-medium text-foreground">
            Não foi possível identificar as colunas automaticamente
          </p>
          <p className="mt-1 text-xs text-foreground-muted">
            Indique qual coluna contém cada informação. Preferimos perguntar a adivinhar — errar
            aqui importaria a lista inteira trocada.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-foreground-muted">Coluna da matrícula</label>
              <select
                className={selectClass}
                value={mapping?.registrationIndex ?? ""}
                onChange={(e) =>
                  handleMappingChange({
                    registrationIndex: Number(e.target.value),
                    nameIndex: mapping?.nameIndex ?? -1,
                  })
                }
              >
                <option value="">Selecione…</option>
                {sheet.header.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Coluna ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-foreground-muted">Coluna do nome</label>
              <select
                className={selectClass}
                value={mapping?.nameIndex ?? ""}
                onChange={(e) =>
                  handleMappingChange({
                    registrationIndex: mapping?.registrationIndex ?? -1,
                    nameIndex: Number(e.target.value),
                  })
                }
              >
                <option value="">Selecione…</option>
                {sheet.header.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Coluna ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Card>
      )}

      {preview && (
        <Card className="mt-4 p-5">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <span className="text-foreground-muted">
              Total de linhas: <strong className="text-foreground">{preview.summary.total}</strong>
            </span>
            <span className="text-foreground-muted">
              Prontas: <strong className="text-foreground">{preview.summary.valid}</strong>
            </span>
            {preview.summary.duplicates > 0 && (
              <span className="text-warning">Duplicadas: {preview.summary.duplicates}</span>
            )}
            {preview.summary.errors > 0 && (
              <span className="text-warning">Com erro: {preview.summary.errors}</span>
            )}
          </div>

          {preview.blocking.length > 0 && (
            <ul className="mt-3 space-y-1 rounded-md bg-warning-bg px-3.5 py-3 text-sm text-warning">
              {preview.blocking.slice(0, 10).map((message) => (
                <li key={message}>{message}</li>
              ))}
              {preview.blocking.length > 10 && (
                <li>e mais {preview.blocking.length - 10} problema(s).</li>
              )}
            </ul>
          )}

          <div className="mt-4 max-h-80 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface-muted text-xs uppercase text-foreground-muted">
                <tr>
                  <th className="px-3 py-2">Linha</th>
                  <th className="px-3 py-2">Matrícula</th>
                  <th className="px-3 py-2">Nome</th>
                  <th className="px-3 py-2">Situação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {preview.rows.slice(0, 200).map((row) => (
                  <tr key={row.lineNumber}>
                    <td className="px-3 py-2 tabular-nums text-foreground-muted">{row.lineNumber}</td>
                    <td className="px-3 py-2 font-mono text-foreground">{row.registrationNumber}</td>
                    <td className="px-3 py-2 text-foreground">{row.fullName}</td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 200 && (
            <p className="mt-2 text-xs text-foreground-muted">
              Mostrando as 200 primeiras de {preview.rows.length} linhas. Todas serão importadas.
            </p>
          )}
        </Card>
      )}

      {state.error && (
        <p role="alert" className="mt-4 rounded-md bg-danger-bg px-3.5 py-3 text-sm text-danger">
          {state.error}
        </p>
      )}

      <div className="mt-6 flex justify-end">
        <Button type="button" size="lg" disabled={!canSubmit} onClick={() => setConfirmOpen(true)}>
          {isPending ? "Importando…" : "Importar eleitores"}
        </Button>
      </div>

      <ConfirmationDialog
        open={confirmOpen}
        title="Confirmar importação"
        description={
          votingOpen
            ? `Serão importados ${preview?.importable.length ?? 0} eleitores COM A VOTAÇÃO ABERTA. Eleitores já cadastrados terão o nome atualizado conforme a planilha — e passarão a precisar do nome novo para votar. Confirma?`
            : `Serão importados ${preview?.importable.length ?? 0} eleitores. Os já cadastrados terão o nome atualizado conforme a planilha; nenhum eleitor é removido e nenhum histórico de voto é alterado. Confirma?`
        }
        confirmLabel="Sim, importar"
        confirming={isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          // Envia o formulário de verdade: o arquivo original vai junto e é
          // reparseado no servidor.
          (document.getElementById("voter-import-submit") as HTMLButtonElement | null)?.click();
        }}
      />
      <button id="voter-import-submit" type="submit" className="hidden" tabIndex={-1} />
    </form>
  );
}
