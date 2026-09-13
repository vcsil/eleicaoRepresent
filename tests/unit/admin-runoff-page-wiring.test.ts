import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ELECTION_STATUSES, isVotingOpen } from "@/lib/election/status-values";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const painel = read("components/admin/ElectionControlPanel.tsx");
const detalhe = read("app/admin/(protected)/desempates/[runoffId]/page.tsx");
const lista = read("app/admin/(protected)/desempates/page.tsx");
const resultadosGerais = read("app/admin/(protected)/resultados/page.tsx");

describe("ElectionControlPanel serve à eleição geral e ao desempate", () => {
  it("habilita o encerramento nos dois status de votação aberta", () => {
    expect(isVotingOpen("votacao_em_andamento")).toBe(true);
    expect(isVotingOpen("votacao_desempate")).toBe(true);
  });

  it("não habilita o encerramento em nenhum outro status", () => {
    const abertos = ELECTION_STATUSES.filter((s) => isVotingOpen(s));
    expect(abertos).toEqual(["votacao_em_andamento", "votacao_desempate"]);
  });

  it("usa o predicado do projeto em vez de comparar a string solta", () => {
    // A comparação literal era justamente o bug: `votacao_desempate` nunca
    // habilitava o botão.
    expect(painel).toContain("canClose = isVotingOpen(status)");
    expect(painel).not.toContain('status === "votacao_em_andamento"');
  });

  it("mantém a apuração cobrindo o ciclo do desempate", () => {
    // Desempate vai de votacao_desempate direto para em_apuracao: nunca
    // passa por votacao_encerrada (compute_election_status, 0010).
    expect(painel).toContain('status === "em_apuracao"');
  });
});

describe("a página do desempate opera sobre o desempate", () => {
  it("valida o id no servidor e responde 404 quando não confere", () => {
    expect(detalhe).toContain("getRunoffDetail(runoffId, election.id)");
    expect(detalhe).toContain("notFound()");
  });

  for (const [rotulo, trecho] of [
    ["status", "getElectionStatus(runoff.id)"],
    ["participação", "getParticipationPercentage(runoff.id)"],
    ["resultados internos", "getInternalResults(runoff.id)"],
    ["ações de encerrar/apurar", "electionId={runoff.id}"],
  ] as const) {
    it(`usa o id do desempate para ${rotulo}`, () => {
      expect(detalhe).toContain(trecho);
    });
  }

  it("nunca passa o id da eleição principal para as ações", () => {
    // `election` na página é a eleição geral, usada só para validar a cadeia.
    expect(detalhe).not.toContain("electionId={election.id}");
    expect(detalhe).not.toContain("getInternalResults(election.id)");
    expect(detalhe).not.toContain("getParticipationPercentage(election.id)");
  });

  it("não duplica a apuração no frontend", () => {
    for (const proibido of ["tie_break_needed =", "elected =", "votes_count +", ".sort((a, b) => b.votes_count"]) {
      expect(detalhe, proibido).not.toContain(proibido);
    }
  });

  it("esconde a publicação enquanto houver novo empate", () => {
    expect(detalhe).toContain('runoff.stage !== "novo_empate" && (');
    expect(detalhe).toContain("Novo empate");
  });

  it("avisa que publicar o desempate não publica a eleição principal", () => {
    expect(detalhe).toContain("NÃO é publicada automaticamente");
  });

  it("mostra o desempate como concluído depois de publicado", () => {
    expect(detalhe).toContain("Desempate concluído");
  });

  it("oferece criar a rodada seguinte a partir do próprio desempate", () => {
    expect(detalhe).toContain("getPendingTies(runoff.id)");
    expect(detalhe).toContain("electionId={runoff.id}");
  });
});

describe("as duas visões continuam separadas", () => {
  it("a lista de desempates leva à página de cada um", () => {
    expect(lista).toContain("/admin/desempates/${r.id}");
    expect(lista).toContain("Gerenciar");
  });

  it("a lista não manda mais publicar o desempate em /admin/resultados", () => {
    // /admin/resultados carrega getMainElection() (type = general): o
    // desempate nunca apareceria lá. A instrução antiga era um beco sem saída.
    expect(lista).not.toContain("Publique esta votação em /admin/resultados");
  });

  it("/admin/resultados continua sendo a visão da eleição principal", () => {
    expect(resultadosGerais).toContain("getMainElection()");
    expect(resultadosGerais).toContain("getInternalResults(election.id)");
    expect(resultadosGerais).toContain("electionId={election.id}");
  });
});
