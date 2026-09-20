import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Num arquivo `"use server"`, TODA exportação precisa ser uma função async.
 * Exportar uma constante de lá quebra o build com
 * "A 'use server' file can only export async functions, found string" —
 * e nem `tsc --noEmit` nem o ESLint enxergam isso.
 *
 * Já aconteceu duas vezes neste projeto (uma constante de mensagem, e antes
 * um módulo que arrastava o cliente de serviço para o bundle do navegador).
 * Este teste é mais barato que descobrir de novo no build.
 */
const raiz = new URL("../../", import.meta.url).pathname;

function arquivosTs(dir: string, encontrados: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (entrada === "node_modules" || entrada === ".next" || entrada.startsWith(".")) continue;
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) arquivosTs(caminho, encontrados);
    else if (/\.tsx?$/.test(entrada)) encontrados.push(caminho);
  }
  return encontrados;
}

const servidores = arquivosTs(join(raiz, "app"))
  .concat(arquivosTs(join(raiz, "lib")))
  .filter((f) => /^\s*["']use server["']/.test(readFileSync(f, "utf8")));

describe('arquivos "use server"', () => {
  it("existem (o teste não está passando por vazio)", () => {
    expect(servidores.length).toBeGreaterThan(3);
  });

  for (const arquivo of servidores) {
    const relativo = arquivo.slice(raiz.length);
    it(`${relativo} exporta apenas funções async`, () => {
      const fonte = readFileSync(arquivo, "utf8");
      // `export type` e `export async function` são permitidos; qualquer
      // outro `export const/let/var/class/function` não é.
      const proibidos = [...fonte.matchAll(/^export\s+(?!type\b|async\s+function\b)(\w+)/gm)].map(
        (m) => m[0].trim(),
      );
      expect({ arquivo: relativo, proibidos }).toEqual({ arquivo: relativo, proibidos: [] });
    });
  }
});
