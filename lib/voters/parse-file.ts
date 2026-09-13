/**
 * Leitura de planilhas de eleitores. Sem "server-only": o navegador lê o
 * arquivo para a pré-visualização e o servidor RELÊ o mesmo arquivo antes
 * de importar. O que o cliente mostra nunca é insumo da gravação.
 *
 * Regra que atravessa tudo aqui: matrícula é STRING, sempre. Converter
 * para número perderia zeros à esquerda ("001234" → 1234), e matrícula com
 * zero à esquerda é comum.
 */

export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_ROWS = 2000;

export class FileParseError extends Error {}

export type SheetTable = {
  /** Nome da planilha (XLSX) ou do arquivo (CSV). */
  name: string;
  /** Primeira linha não vazia, usada como cabeçalho. */
  header: string[];
  /** Demais linhas, já como texto. */
  rows: string[][];
};

export type ParsedWorkbook = {
  kind: "csv" | "xlsx";
  sheets: SheetTable[];
};

/* ------------------------------------------------------------------ CSV */

/**
 * Detecta o separador contando ocorrências fora de aspas na primeira linha.
 * Excel em português salva com ";" por padrão, e um arquivo pt-BR com nomes
 * contendo vírgula é justamente o caso em que adivinhar errado corrompe
 * tudo em silêncio.
 */
function detectDelimiter(firstLine: string): "," | ";" {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;

  for (let i = 0; i < firstLine.length; i += 1) {
    const char = firstLine[i];
    if (char === '"') {
      if (inQuotes && firstLine[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (char === ",") commas += 1;
      if (char === ";") semicolons += 1;
    }
  }

  return semicolons > commas ? ";" : ",";
}

/** Parser CSV completo: aspas, aspas escapadas, quebra de linha dentro do campo. */
function parseCsvText(text: string): string[][] {
  // Remove BOM — arquivos salvos pelo Excel quase sempre trazem.
  const clean = text.replace(/^﻿/, "");
  const firstLineEnd = clean.search(/\r?\n/);
  const delimiter = detectDelimiter(firstLineEnd === -1 ? clean : clean.slice(0, firstLineEnd));

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];

    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/* ----------------------------------------------------------------- XLSX */

/**
 * Lê o TEXTO da célula, nunca o valor numérico.
 *
 * Se a planilha guardou a matrícula como número, o zero à esquerda já se
 * perdeu dentro do arquivo e nenhuma biblioteca o recupera — mas ao menos
 * não somamos um segundo erro convertendo de novo. `numericRegistration`
 * sinaliza esse caso para a interface avisar.
 */
async function parseXlsx(buffer: ArrayBuffer): Promise<SheetTable[]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new FileParseError("Não foi possível ler a planilha. O arquivo pode estar corrompido.");
  }

  const sheets: SheetTable[] = [];

  workbook.eachSheet((worksheet) => {
    const all: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (excelRow) => {
      const values: string[] = [];
      // `cellCount` inclui as colunas vazias no meio da linha.
      for (let col = 1; col <= worksheet.columnCount; col += 1) {
        const cell = excelRow.getCell(col);
        // `.text` devolve o valor formatado como aparece na planilha.
        values.push(typeof cell.text === "string" ? cell.text : String(cell.text ?? ""));
      }
      all.push(values);
    });

    const nonEmpty = all.filter((r) => r.some((c) => c.trim() !== ""));
    if (nonEmpty.length === 0) return;

    sheets.push({
      name: worksheet.name,
      header: nonEmpty[0].map((c) => c.trim()),
      rows: nonEmpty.slice(1),
    });
  });

  return sheets;
}

/* --------------------------------------------------------------- pública */

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/**
 * Converte o arquivo em tabelas de texto. Não valida conteúdo — isso é
 * responsabilidade de `validate-import.ts`, que roda nos dois lados.
 */
export async function parseVotersFile(file: File): Promise<ParsedWorkbook> {
  if (file.size === 0) {
    throw new FileParseError("O arquivo está vazio.");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new FileParseError("O arquivo deve ter no máximo 2 MB.");
  }

  const ext = extensionOf(file.name);

  if (ext === "csv" || ext === "txt") {
    const rows = parseCsvText(await file.text());
    const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
    if (nonEmpty.length === 0) {
      throw new FileParseError("O arquivo está vazio.");
    }
    return {
      kind: "csv",
      sheets: [
        { name: file.name, header: nonEmpty[0].map((c) => c.trim()), rows: nonEmpty.slice(1) },
      ],
    };
  }

  if (ext === "xlsx") {
    const sheets = await parseXlsx(await file.arrayBuffer());
    if (sheets.length === 0) {
      throw new FileParseError("A planilha não tem nenhuma aba com conteúdo.");
    }
    return { kind: "xlsx", sheets };
  }

  throw new FileParseError("Formato não suportado. Envie um arquivo .csv ou .xlsx.");
}
