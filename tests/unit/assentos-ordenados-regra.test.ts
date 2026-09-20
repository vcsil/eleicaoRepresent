import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A regra "este cargo precisa de votação?" mora em UM lugar: a função
 * `position_requires_voting` no PostgreSQL (migration 0022).
 *
 * O comportamento está coberto contra um banco real em
 * `tests/integration/assentos-ordenados.test.ts`. Aqui se verifica o que
 * nenhum teste de comportamento pega sozinho: que nenhum consumidor voltou
 * a reimplementar a classificação por conta própria — foi a comparação
 * duplicada dentro de `compute_results` que deixou a apuração e a urna
 * poderem discordar.
 */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const m22 = read("supabase/migrations/0022_ordered_seats_and_composition_freeze.sql");
const ballotOptions = read("lib/election/ballot-options.ts");
const freeze = read("lib/election/composition-freeze.ts");
const composition = read("lib/admin/composition.ts");

describe("a regra existe uma vez só", () => {
  it("é definida em position_requires_voting, com seat_labels", () => {
    expect(m22).toContain("create or replace function public.position_requires_voting");
    expect(m22).toMatch(/seat_labels is not null or v_candidatos > p\.vacancies/);
  });

  it("os quatro consumidores em SQL chamam o helper", () => {
    // get_current_voting_election, cast_ballot, voting_position_ids e
    // compute_results.
    const chamadas = m22.match(/position_requires_voting\(/g) ?? [];
    // 1 definição + 1 alias + 4 consumidores.
    expect(chamadas.length).toBeGreaterThanOrEqual(6);
  });

  it("compute_results não volta a comparar candidatos e vagas por conta própria", () => {
    // Era `if v_elegiveis <= v_vacancies then` — a duplicação que permitia
    // apurar um cargo de forma diferente da que a urna o classificou.
    expect(m22).not.toMatch(/if v_elegiveis <= v_vacancies then/);
    expect(m22).toContain("if v_election.type = 'general' and not position_requires_voting(");
  });

  it("o nome antigo continua existindo, mas delegando", () => {
    // Qualquer chamador que tenha ficado para trás recebe a MESMA resposta
    // em vez de divergir em silêncio.
    expect(m22).toMatch(/function public\.position_is_contested[\s\S]*?select position_requires_voting/);
    expect(m22).toMatch(/function public\.contested_position_ids[\s\S]*?select voting_position_ids/);
  });

  it("o TypeScript não recalcula nada: só lê a lista do banco", () => {
    expect(freeze).toContain('supabase.rpc("voting_position_ids")');
    for (const fonte of [ballotOptions, composition]) {
      expect(fonte).toContain("getVotingPositionIds");
      expect(fonte).not.toMatch(/seat_labels\s*!==\s*null\s*\|\|/);
      expect(fonte).not.toMatch(/candidates\.length\s*>\s*\w*[Vv]acancies/);
    }
  });
});

describe("empate de ORDEM em cargo com assentos nomeados", () => {
  it("cargo ordenado trata empate na faixa eleita como pendência", () => {
    expect(m22).toContain("v_ordenado");
    expect(m22).toMatch(/case when v_ordenado[\s\S]*?ranked\.tie_group_size > 1/);
  });

  it("cargo SEM assento nomeado mantém a fórmula anterior", () => {
    expect(m22).toMatch(
      /else \(ranked\.rnk <= v_vacancies and \(ranked\.rnk \+ ranked\.tie_group_size - 1\) > v_vacancies\)/,
    );
  });

  it("a numeração de assentos deixou de depender da ordem física das linhas", () => {
    expect(m22).toContain("order by votes_count desc, candidate_id asc");
    expect(m22).not.toMatch(/row_number\(\) over \(order by rank asc\) as seat_index/);
  });
});

describe("desempate de cargo ordenado", () => {
  it("dá 1 voto por eleitor, decidido no banco", () => {
    expect(m22).toContain("case when v_ordenado then 1 else v_in_dispute end");
  });

  it("parte da versão MAIS RECENTE de create_runoff_election (0019)", () => {
    // A 0019 é a que traz a guarda de janelas sobrepostas; reescrever a
    // partir da 0014 a teria revertido em silêncio.
    expect(m22).toContain("RUNOFF_WINDOW_OVERLAP");
    expect(m22).toContain("RUNOFF_ALREADY_EXISTS");
  });
});

describe("congelamento no banco", () => {
  it("cobre as três tabelas estruturais", () => {
    for (const tabela of ["candidates", "candidate_positions", "positions"]) {
      expect(m22).toContain(`before insert or update or delete on public.${tabela}`);
    }
  });

  it("toma lock em vez de só ler o estado", () => {
    // `for share` conflita com o `for update` de release_voting: sem ele, a
    // escrita direta voltaria a correr contra a liberação.
    expect(m22).toMatch(/from elections[\s\S]*?for share/);
  });

  it("deixa passar os campos informativos", () => {
    for (const campo of ["full_name", "active", "display_order"]) {
      expect(m22).toContain(`new.${campo} is not distinct from old.${campo}`);
    }
    for (const campo of ["vacancies", "votes_per_voter", "seat_labels"]) {
      expect(m22).toContain(`new.${campo} is not distinct from old.${campo}`);
    }
  });

  it("a guarda de última instância continua no lugar", () => {
    expect(m22).toContain("UNCONTESTED_POSITION_HAS_VOTES");
  });
});
