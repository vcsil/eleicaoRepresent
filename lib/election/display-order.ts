/** Regras de ordenacao exclusivamente visuais, sem efeito na apuracao. */

type NamedCandidate = {
  id?: string | null;
  candidate_id?: string | null;
  full_name?: string | null;
  candidate_name?: string | null;
};

type ResultCandidate = NamedCandidate & {
  votes_count: number;
};

const portugueseNameCollator = new Intl.Collator("pt-BR", {
  sensitivity: "base",
  usage: "sort",
});

function candidateName(candidate: NamedCandidate): string {
  return candidate.full_name ?? candidate.candidate_name ?? "";
}

function candidateId(candidate: NamedCandidate): string {
  return candidate.id ?? candidate.candidate_id ?? "";
}

/** Nome exibido em pt-BR; o id torna a saida deterministica para nomes iguais. */
export function compareCandidatesByName(a: NamedCandidate, b: NamedCandidate): number {
  return (
    portugueseNameCollator.compare(candidateName(a), candidateName(b)) ||
    candidateName(a).localeCompare(candidateName(b), "pt-BR") ||
    candidateId(a).localeCompare(candidateId(b))
  );
}

/** Ordem visual dos resultados. `rank` deliberadamente nao participa. */
export function compareCandidateResults(a: ResultCandidate, b: ResultCandidate): number {
  return b.votes_count - a.votes_count || compareCandidatesByName(a, b);
}

