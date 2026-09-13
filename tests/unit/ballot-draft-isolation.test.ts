import { describe, expect, it } from "vitest";
import {
  BALLOT_DRAFT_KEY_PREFIX,
  buildDraftStorageKey,
  pruneOtherDrafts,
} from "@/lib/vote/draft";

/**
 * Isolamento do rascunho entre eleitores no MESMO dispositivo.
 *
 * O rascunho usava uma chave fixa em sessionStorage, sem vínculo com a
 * sessão de voto. Um eleitor que abandonava a urna deixava sua
 * distribuição para o próximo — que a via na tela e, se estivesse
 * completa, podia enviá-la como se fosse dele. Demonstrado em navegador
 * real antes da correção.
 */

/** sessionStorage mínimo, com a mesma semântica de índice usada no prune. */
function createStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

const CHAVE_A = buildDraftStorageKey("aaaaaaaaaaaaaaaa");
const CHAVE_B = buildDraftStorageKey("bbbbbbbbbbbbbbbb");

describe("buildDraftStorageKey", () => {
  it("gera chaves distintas para sessões distintas", () => {
    expect(CHAVE_A).not.toBe(CHAVE_B);
  });

  it("mantém o prefixo comum, para o prune reconhecer as chaves", () => {
    expect(CHAVE_A.startsWith(BALLOT_DRAFT_KEY_PREFIX)).toBe(true);
  });
});

describe("isolamento entre eleitores", () => {
  it("o eleitor B não enxerga o rascunho do eleitor A", () => {
    const storage = createStorage({ [CHAVE_A]: JSON.stringify({ presidente: { ana: 1 } }) });

    // B chega com sua própria sessão e lê pela SUA chave.
    expect(storage.getItem(CHAVE_B)).toBeNull();
  });

  it("o prune apaga o rascunho do eleitor anterior do dispositivo", () => {
    const storage = createStorage({
      [CHAVE_A]: JSON.stringify({ presidente: { ana: 1 } }),
      "outra-coisa-qualquer": "preservar",
    });

    pruneOtherDrafts(storage, CHAVE_B);

    expect(storage.getItem(CHAVE_A)).toBeNull();
    // Não é uma vassoura: só mexe no que é rascunho de urna.
    expect(storage.getItem("outra-coisa-qualquer")).toBe("preservar");
  });

  it("o prune preserva o rascunho da sessão atual", () => {
    const meu = JSON.stringify({ presidente: { bruno: 1 } });
    const storage = createStorage({ [CHAVE_A]: "do outro", [CHAVE_B]: meu });

    pruneOtherDrafts(storage, CHAVE_B);

    expect(storage.getItem(CHAVE_B)).toBe(meu);
    expect(storage.getItem(CHAVE_A)).toBeNull();
  });

  it("recolhe também a chave fixa antiga, de antes da correção", () => {
    const storage = createStorage({ [BALLOT_DRAFT_KEY_PREFIX]: JSON.stringify({ x: { y: 1 } }) });

    pruneOtherDrafts(storage, CHAVE_B);

    expect(storage.getItem(BALLOT_DRAFT_KEY_PREFIX)).toBeNull();
  });

  it("apaga rascunhos de várias sessões anteriores de uma vez", () => {
    const storage = createStorage({
      [buildDraftStorageKey("1111111111111111")]: "a",
      [buildDraftStorageKey("2222222222222222")]: "b",
      [buildDraftStorageKey("3333333333333333")]: "c",
      [CHAVE_B]: "meu",
    });

    pruneOtherDrafts(storage, CHAVE_B);

    expect(storage.length).toBe(1);
    expect(storage.getItem(CHAVE_B)).toBe("meu");
  });
});
