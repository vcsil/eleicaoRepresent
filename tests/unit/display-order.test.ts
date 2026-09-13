import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareCandidateResults,
  compareCandidatesByName,
} from "@/lib/election/display-order";

describe("ordem visual de candidatos", () => {
  it("mantem os seis cargos oficiais na ordem definida por display_order", () => {
    const seed = readFileSync("supabase/seed.sql", "utf8");
    const positions = Array.from(
      seed.matchAll(/\('[^']+', '([^']+)', \d+, \d+, [\s\S]*?\n\s+(\d+)\)(?:,|\n)/g),
      (match) => ({ name: match[1], display_order: Number(match[2]) }),
    ).slice(0, 6);

    expect(positions.sort((a, b) => a.display_order - b.display_order)).toEqual([
      { name: "Presidente", display_order: 1 },
      { name: "Vice-Presidente", display_order: 2 },
      { name: "Tesouraria", display_order: 3 },
      { name: "Secretaria", display_order: 4 },
      { name: "Marketing", display_order: 5 },
      { name: "Eventos", display_order: 6 },
    ]);
  });

  it("ordena alfabeticamente pelo nome exibido sem alterar ids", () => {
    const candidates = [
      { id: "id-zoe", full_name: "Zoé Lima" },
      { id: "id-alvaro", full_name: "Álvaro Rocha" },
      { id: "id-ana", full_name: "Ana Monteiro" },
    ];

    const ordered = [...candidates].sort(compareCandidatesByName);

    expect(ordered.map((candidate) => candidate.full_name)).toEqual([
      "Álvaro Rocha",
      "Ana Monteiro",
      "Zoé Lima",
    ]);
    expect(ordered.map((candidate) => candidate.id).sort()).toEqual([
      "id-alvaro",
      "id-ana",
      "id-zoe",
    ]);
  });

  it("ordena resultados por votos e estabiliza empates por nome sem alterar rank", () => {
    const results = [
      { candidate_id: "b", candidate_name: "Bruno", votes_count: 7, rank: 1 },
      { candidate_id: "c", candidate_name: "Carla", votes_count: 10, rank: 2 },
      { candidate_id: "a", candidate_name: "Ana", votes_count: 10, rank: 2 },
    ];

    const ordered = [...results].sort(compareCandidateResults);

    expect(ordered.map((row) => row.candidate_name)).toEqual(["Ana", "Carla", "Bruno"]);
    expect(ordered.map((row) => row.rank)).toEqual([2, 2, 1]);
  });

  it("mantem votos nulos fora da ordenacao de candidatos", () => {
    const rows = [
      { candidate_id: null, candidate_name: null, votes_count: 99 },
      { candidate_id: "a", candidate_name: "Ana", votes_count: 5 },
      { candidate_id: "b", candidate_name: "Bruno", votes_count: 8 },
    ];
    const candidates = rows
      .filter((row) => row.candidate_id !== null)
      .sort(compareCandidateResults);
    const nullVotes = rows.filter((row) => row.candidate_id === null);

    expect(candidates.map((row) => row.candidate_name)).toEqual(["Bruno", "Ana"]);
    expect(nullVotes).toEqual([rows[0]]);
  });
});
