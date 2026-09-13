import { MAX_ROWS, type SheetTable } from "@/lib/voters/parse-file";

/**
 * Validação pura da planilha de eleitores — sem I/O, sem banco.
 *
 * Usada no navegador (pré-visualização) e de novo no servidor (verdade).
 * Rodar a MESMA função nos dois lados garante que o que o administrador viu
 * é o que será importado; rodar de novo no servidor garante que um cliente
 * adulterado não importe outra coisa.
 */

export type ColumnMapping = { registrationIndex: number; nameIndex: number };

export type RowStatus =
  | "new"
  | "existing"
  | "missing_registration"
  | "missing_name"
  | "duplicate_in_file";

export type ValidatedRow = {
  /** Linha no arquivo como o administrador a vê (cabeçalho = 1). */
  lineNumber: number;
  registrationNumber: string;
  fullName: string;
  status: RowStatus;
  /** Nome atual no banco, quando a matrícula já existe e o nome vai mudar. */
  currentFullName?: string;
};

export type ValidationSummary = {
  total: number;
  valid: number;
  existing: number;
  errors: number;
  duplicates: number;
};

export type ValidationResult = {
  rows: ValidatedRow[];
  summary: ValidationSummary;
  /** Só linhas aptas a importar. */
  importable: { registration_number: string; full_name: string }[];
  /** Bloqueia o botão: erro que o administrador precisa resolver no arquivo. */
  blocking: string[];
};

const REGISTRATION_HEADERS = [
  "matricula",
  "matriculas",
  "registration_number",
  "registration",
  "ra",
  "rga",
  "inscricao",
  "numero de matricula",
  "n matricula",
];

const NAME_HEADERS = [
  "nome",
  "nome completo",
  "nome do aluno",
  "aluno",
  "aluna",
  "full_name",
  "fullname",
  "eleitor",
];

/** Compara cabeçalhos ignorando acento, caixa, pontuação e espaços extras. */
function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tenta identificar as colunas pelo cabeçalho.
 *
 * Devolve null quando não há UMA correspondência clara — nenhuma, ou mais
 * de uma candidata para o mesmo campo. Nesse caso a interface pede que o
 * administrador escolha. Errar a coluna importa a lista inteira errada, e
 * adivinhar por posição seria exatamente a heurística perigosa a evitar.
 */
export function detectColumns(header: string[]): ColumnMapping | null {
  const normalized = header.map(normalizeHeader);

  const matches = (candidates: string[]) =>
    normalized.reduce<number[]>((acc, value, index) => {
      if (candidates.includes(value)) acc.push(index);
      return acc;
    }, []);

  const registration = matches(REGISTRATION_HEADERS);
  const name = matches(NAME_HEADERS);

  if (registration.length !== 1 || name.length !== 1) return null;
  if (registration[0] === name[0]) return null;

  return { registrationIndex: registration[0], nameIndex: name[0] };
}

/**
 * Valida as linhas contra o mapeamento escolhido e contra as matrículas já
 * existentes no banco.
 *
 * `existingByRegistration` vem do servidor; no navegador pode chegar vazio,
 * e nesse caso o preview só não distingue "novo" de "já cadastrado" — o
 * servidor revalida antes de gravar.
 */
export function validateRows(
  sheet: SheetTable,
  mapping: ColumnMapping,
  existingByRegistration: Map<string, string> = new Map(),
): ValidationResult {
  const blocking: string[] = [];

  if (sheet.rows.length === 0) {
    blocking.push("O arquivo não tem nenhuma linha de dados além do cabeçalho.");
  }
  if (sheet.rows.length > MAX_ROWS) {
    blocking.push(`O arquivo tem mais de ${MAX_ROWS} linhas.`);
  }

  // Primeira passada: conta ocorrências para identificar duplicata no arquivo.
  const occurrences = new Map<string, number>();
  for (const raw of sheet.rows) {
    const registration = (raw[mapping.registrationIndex] ?? "").trim();
    if (registration === "") continue;
    occurrences.set(registration, (occurrences.get(registration) ?? 0) + 1);
  }

  const rows: ValidatedRow[] = [];

  sheet.rows.forEach((raw, index) => {
    const registrationNumber = (raw[mapping.registrationIndex] ?? "").trim();
    const fullName = (raw[mapping.nameIndex] ?? "").trim();

    // Linha completamente vazia é ignorada; parcialmente preenchida é erro.
    const everythingEmpty = raw.every((cell) => (cell ?? "").trim() === "");
    if (everythingEmpty || (registrationNumber === "" && fullName === "")) return;

    const lineNumber = index + 2; // +1 pelo cabeçalho, +1 porque humanos contam de 1

    let status: RowStatus;
    let currentFullName: string | undefined;

    if (registrationNumber === "") {
      status = "missing_registration";
    } else if (fullName === "") {
      status = "missing_name";
    } else if ((occurrences.get(registrationNumber) ?? 0) > 1) {
      status = "duplicate_in_file";
    } else if (existingByRegistration.has(registrationNumber)) {
      status = "existing";
      currentFullName = existingByRegistration.get(registrationNumber);
    } else {
      status = "new";
    }

    rows.push({ lineNumber, registrationNumber, fullName, status, currentFullName });
  });

  for (const row of rows) {
    if (row.status === "missing_registration") {
      blocking.push(`Linha ${row.lineNumber}: matrícula ausente.`);
    }
    if (row.status === "missing_name") {
      blocking.push(`Linha ${row.lineNumber}: nome ausente (matrícula ${row.registrationNumber}).`);
    }
    if (row.status === "duplicate_in_file") {
      blocking.push(
        `Linha ${row.lineNumber}: a matrícula ${row.registrationNumber} aparece mais de uma vez no arquivo.`,
      );
    }
  }

  const importable = rows
    .filter((r) => r.status === "new" || r.status === "existing")
    .map((r) => ({ registration_number: r.registrationNumber, full_name: r.fullName }));

  if (rows.length > 0 && importable.length === 0) {
    blocking.push("Nenhuma linha do arquivo pode ser importada.");
  }

  return {
    rows,
    summary: {
      total: rows.length,
      valid: rows.filter((r) => r.status === "new").length,
      existing: rows.filter((r) => r.status === "existing").length,
      errors: rows.filter(
        (r) => r.status === "missing_registration" || r.status === "missing_name",
      ).length,
      duplicates: rows.filter((r) => r.status === "duplicate_in_file").length,
    },
    importable,
    // Mensagens repetidas viram ruído numa planilha com muitos problemas.
    blocking: Array.from(new Set(blocking)).slice(0, 50),
  };
}
