import { describe, expect, it } from "vitest";
import { parseVotersFile, FileParseError, MAX_FILE_BYTES } from "@/lib/voters/parse-file";
import { detectColumns, validateRows } from "@/lib/voters/validate-import";

/**
 * Leitura e validação da planilha de eleitores.
 *
 * A regra que atravessa quase todos estes testes: matrícula é STRING.
 * Converter para número perde zeros à esquerda, e "001234" virar 1234
 * significa um eleitor que não consegue votar.
 */

function csvFile(content: string, name = "eleitores.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

async function xlsxFile(rows: (string | number)[][], sheets = 1): Promise<File> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  for (let i = 0; i < sheets; i += 1) {
    const sheet = workbook.addWorksheet(i === 0 ? "Turma 36" : `Aba ${i + 1}`);
    for (const row of rows) sheet.addRow(row);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "eleitores.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** Atalho: lê o arquivo, detecta colunas e valida. */
async function process(file: File, existing = new Map<string, string>()) {
  const workbook = await parseVotersFile(file);
  const sheet = workbook.sheets[0];
  const mapping = detectColumns(sheet.header);
  if (!mapping) throw new Error("colunas não detectadas");
  return { workbook, sheet, ...validateRows(sheet, mapping, existing) };
}

describe("CSV", () => {
  it("lê um arquivo separado por vírgula", async () => {
    const result = await process(
      csvFile("Matrícula,Nome\n20260001,Ana Maria Silva\n20260002,Bruno Souza Costa\n"),
    );

    expect(result.summary.total).toBe(2);
    expect(result.importable).toEqual([
      { registration_number: "20260001", full_name: "Ana Maria Silva" },
      { registration_number: "20260002", full_name: "Bruno Souza Costa" },
    ]);
  });

  it("lê um arquivo separado por ponto e vírgula (padrão do Excel pt-BR)", async () => {
    const result = await process(csvFile("Matrícula;Nome\n20260001;Ana Maria Silva\n"));

    expect(result.importable).toEqual([
      { registration_number: "20260001", full_name: "Ana Maria Silva" },
    ]);
  });

  it("preserva nome com vírgula dentro de aspas", async () => {
    // Se o separador fosse adivinhado errado, este nome viraria duas colunas.
    const result = await process(csvFile('Matrícula,Nome\n20260001,"Silva, Ana Maria"\n'));

    expect(result.importable[0].full_name).toBe("Silva, Ana Maria");
  });

  it("remove o BOM que o Excel grava no início do arquivo", async () => {
    const result = await process(csvFile("﻿Matrícula,Nome\n20260001,Ana\n"));

    // Sem o tratamento, o cabeçalho viria "﻿Matrícula" e a detecção falharia.
    expect(result.importable).toHaveLength(1);
  });

  it("preserva acentos", async () => {
    const result = await process(csvFile("Matrícula,Nome\n20260001,João Gonçalves Íris\n"));

    expect(result.importable[0].full_name).toBe("João Gonçalves Íris");
  });

  it("preserva zeros à esquerda da matrícula", async () => {
    const result = await process(csvFile("Matrícula,Nome\n001234,Ana Maria\n"));

    expect(result.importable[0].registration_number).toBe("001234");
  });

  it("aplica trim sem alterar a caixa do nome", async () => {
    const result = await process(csvFile("Matrícula,Nome\n  20260001  ,  Ana MARIA Silva  \n"));

    expect(result.importable[0]).toEqual({
      registration_number: "20260001",
      full_name: "Ana MARIA Silva",
    });
  });
});

describe("XLSX", () => {
  it("lê uma planilha válida", async () => {
    const file = await xlsxFile([
      ["Matrícula", "Nome"],
      ["20260001", "Ana Maria Silva"],
      ["20260002", "Bruno Souza Costa"],
    ]);
    const result = await process(file);

    expect(result.importable).toHaveLength(2);
    expect(result.importable[0].full_name).toBe("Ana Maria Silva");
  });

  it("lê a matrícula como texto, não como número", async () => {
    const file = await xlsxFile([
      ["Matrícula", "Nome"],
      ["20260001", "Ana"],
    ]);
    const result = await process(file);

    // Se fosse lido como número, viraria 20260001 e perderia a natureza de
    // string — o risco real aparece com zeros à esquerda.
    expect(typeof result.importable[0].registration_number).toBe("string");
    expect(result.importable[0].registration_number).toBe("20260001");
  });

  it("expõe todas as abas quando há mais de uma", async () => {
    const file = await xlsxFile(
      [
        ["Matrícula", "Nome"],
        ["20260001", "Ana"],
      ],
      3,
    );
    const workbook = await parseVotersFile(file);

    // A interface pergunta qual importar; nunca escolhe sozinha.
    expect(workbook.sheets).toHaveLength(3);
  });
});

describe("detecção de colunas", () => {
  it("reconhece variações comuns de cabeçalho", () => {
    for (const header of [
      ["Matrícula", "Nome"],
      ["matricula", "nome completo"],
      ["MATRICULA", "ALUNO"],
      ["registration_number", "full_name"],
      ["RA", "Nome do aluno"],
    ]) {
      expect(detectColumns(header)).not.toBeNull();
    }
  });

  it("devolve null quando não há correspondência — a interface pergunta", () => {
    expect(detectColumns(["Coluna A", "Coluna B"])).toBeNull();
  });

  it("devolve null quando há ambiguidade em vez de escolher uma", () => {
    // Duas colunas candidatas a nome: adivinhar aqui importaria a lista errada.
    expect(detectColumns(["Matrícula", "Nome", "Nome completo"])).toBeNull();
  });

  it("aceita as colunas em qualquer ordem", () => {
    expect(detectColumns(["Nome", "Matrícula"])).toEqual({
      registrationIndex: 1,
      nameIndex: 0,
    });
  });
});

describe("validação de linhas", () => {
  it("ignora linhas completamente vazias", async () => {
    const result = await process(
      csvFile("Matrícula,Nome\n20260001,Ana\n,\n\n20260002,Bruno\n"),
    );

    expect(result.summary.total).toBe(2);
    expect(result.blocking).toHaveLength(0);
  });

  it("marca erro quando só o nome está ausente", async () => {
    const result = await process(csvFile("Matrícula,Nome\n20260001,\n"));

    expect(result.rows[0].status).toBe("missing_name");
    expect(result.blocking[0]).toContain("Linha 2");
    expect(result.blocking[0]).toContain("nome ausente");
  });

  it("marca erro quando só a matrícula está ausente", async () => {
    const result = await process(csvFile("Matrícula,Nome\n,Ana Maria\n"));

    expect(result.rows[0].status).toBe("missing_registration");
    expect(result.blocking[0]).toContain("matrícula ausente");
  });

  it("marca AMBAS as linhas duplicadas, sem escolher uma", async () => {
    const result = await process(
      csvFile("Matrícula,Nome\n20260001,Ana Silva\n20260001,Ana Maria Silva\n"),
    );

    expect(result.rows.every((r) => r.status === "duplicate_in_file")).toBe(true);
    expect(result.summary.duplicates).toBe(2);
    expect(result.importable).toHaveLength(0);

    // Bloqueia CITANDO a matrícula: o administrador precisa saber qual
    // linha resolver. Uma mensagem genérica não serve — e asserção genérica
    // aqui deixaria passar a remoção deste bloqueio.
    const mensagem = result.blocking.find((m) => m.includes("20260001"));
    expect(mensagem).toBeDefined();
    expect(mensagem).toMatch(/mais de uma vez/);
  });

  it("distingue matrícula já cadastrada e mostra o nome atual", async () => {
    const existing = new Map([["20260002", "Bruno Costa"]]);
    const result = await process(
      csvFile("Matrícula,Nome\n20260001,Ana\n20260002,Bruno Souza Costa\n"),
      existing,
    );

    expect(result.rows[0].status).toBe("new");
    expect(result.rows[1].status).toBe("existing");
    expect(result.rows[1].currentFullName).toBe("Bruno Costa");
    expect(result.summary.existing).toBe(1);
    // Já cadastrado NÃO bloqueia — o nome será atualizado.
    expect(result.blocking).toHaveLength(0);
    expect(result.importable).toHaveLength(2);
  });

  it("processa 100 eleitores válidos", async () => {
    const linhas = Array.from(
      { length: 100 },
      (_, i) => `2026${String(i).padStart(4, "0")},Eleitor ${i}`,
    ).join("\n");
    const result = await process(csvFile(`Matrícula,Nome\n${linhas}\n`));

    expect(result.summary.total).toBe(100);
    expect(result.summary.valid).toBe(100);
    expect(result.blocking).toHaveLength(0);
  });
});

describe("arquivos rejeitados", () => {
  it("recusa arquivo vazio", async () => {
    await expect(parseVotersFile(csvFile(""))).rejects.toThrow(FileParseError);
  });

  it("recusa extensão não suportada", async () => {
    await expect(parseVotersFile(csvFile("a,b", "lista.pdf"))).rejects.toThrow(/csv ou \.xlsx/);
  });

  it("recusa arquivo acima do limite", async () => {
    const grande = new File(["x".repeat(MAX_FILE_BYTES + 1)], "grande.csv", { type: "text/csv" });
    await expect(parseVotersFile(grande)).rejects.toThrow(/2 MB/);
  });

  it("recusa XLSX corrompido sem vazar erro técnico", async () => {
    const corrompido = new File([new Uint8Array([1, 2, 3, 4])], "x.xlsx");
    await expect(parseVotersFile(corrompido)).rejects.toThrow(/corrompido/);
  });

  it("recusa CSV só com cabeçalho", async () => {
    const workbook = await parseVotersFile(csvFile("Matrícula,Nome\n"));
    const mapping = detectColumns(workbook.sheets[0].header)!;
    const result = validateRows(workbook.sheets[0], mapping);

    expect(result.blocking[0]).toContain("nenhuma linha de dados");
  });
});
