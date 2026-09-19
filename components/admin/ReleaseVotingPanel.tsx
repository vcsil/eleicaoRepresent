"use client";

import { useState, useTransition } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { releaseVotingAction } from "@/app/admin/(protected)/votacao/actions";

export type ReleasePreviewPosition = {
  id: string;
  name: string;
  vacancies: number;
  activeCandidates: number;
};

/**
 * Liberação da votação — a única porta que abre a urna.
 *
 * O botão só some quando não cabe mais liberar; quem recusa de verdade é
 * `release_voting` no Postgres. O resumo existe porque a liberação é
 * irreversível e CONGELA a composição: a pessoa precisa ver, antes de
 * clicar, exatamente quais cargos irão à urna e quais serão definidos sem
 * disputa.
 */
export function ReleaseVotingPanel({
  electionId,
  contested,
  uncontested,
  released,
  canRelease,
  compositionDigest,
}: {
  electionId: string;
  contested: ReleasePreviewPosition[];
  uncontested: ReleasePreviewPosition[];
  released: boolean;
  canRelease: boolean;
  /** Digital da composição que ESTE resumo descreve (conferida no banco). */
  compositionDigest: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      setError(null);
      const formData = new FormData();
      formData.set("election_id", electionId);
      formData.set("composition_digest", compositionDigest);
      const result = await releaseVotingAction({ error: null }, formData);
      if (result.error) setError(result.error);
      else setOpen(false);
    });
  }

  if (released) {
    return (
      <p className="text-sm text-success">
        Votação liberada. A composição da eleição está congelada — nome, cargos, ordem e
        ativação dos candidatos não podem mais mudar.
      </p>
    );
  }

  return (
    <div>
      <Button type="button" disabled={!canRelease} onClick={() => setOpen(true)}>
        Liberar votação
      </Button>
      <p className="mt-2 text-sm text-foreground-muted">
        A urna só abre depois desta liberação, ainda que o horário do cronograma já tenha
        chegado. A ação é <strong>irreversível</strong>.
      </p>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      <Sheet open={open} onClose={() => setOpen(false)} title="Liberar votação">
        <div className="space-y-4 text-sm">
          <p className="rounded-md bg-warning-bg px-3.5 py-2.5 text-warning">
            Esta ação é irreversível e <strong>congela a composição</strong>: depois dela não é
            mais possível cadastrar, remover, ativar, inativar, renomear, reordenar ou trocar o
            cargo de nenhum candidato. Foto, frase, apresentação, propostas e vídeo continuam
            editáveis.
          </p>

          <section>
            <h3 className="font-semibold text-foreground">Cargos que irão à urna</h3>
            {contested.length === 0 ? (
              <p className="mt-1 text-foreground-muted">
                Nenhum cargo tem disputa. Nenhum voto será registrado, e todos os candidatos
                serão definidos sem disputa na apuração.
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-foreground-muted">
                {contested.map((position) => (
                  <li key={position.id}>
                    {position.name} — {position.activeCandidates}{" "}
                    {position.activeCandidates === 1 ? "candidato" : "candidatos"} para{" "}
                    {position.vacancies} {position.vacancies === 1 ? "vaga" : "vagas"}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="font-semibold text-foreground">Cargos sem disputa</h3>
            {uncontested.length === 0 ? (
              <p className="mt-1 text-foreground-muted">Nenhum.</p>
            ) : (
              <>
                <ul className="mt-1 space-y-1 text-foreground-muted">
                  {uncontested.map((position) => (
                    <li key={position.id}>
                      {position.name} — {position.activeCandidates}{" "}
                      {position.activeCandidates === 1 ? "candidato" : "candidatos"} para{" "}
                      {position.vacancies} {position.vacancies === 1 ? "vaga" : "vagas"}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-foreground-muted">
                  Estes cargos não aparecem na urna e ninguém vota neles. Os candidatos são
                  declarados eleitos sem disputa na apuração; vagas sem candidato ficam
                  registradas como não preenchidas.
                </p>
              </>
            )}
          </section>
        </div>

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setOpen(false)}
            disabled={isPending}
          >
            Cancelar
          </Button>
          <Button type="button" onClick={confirm} disabled={isPending}>
            {isPending ? "Liberando..." : "Liberar votação"}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
