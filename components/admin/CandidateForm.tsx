"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { upsertCandidateAction, type CandidateFormState } from "@/app/admin/(protected)/candidatos/actions";
import type { AdminCandidate } from "@/lib/admin/candidates";
import type { Position } from "@/lib/election/positions";

const initialState: CandidateFormState = { error: null };

const inputClass =
  "mt-1.5 block w-full rounded-md border border-border bg-surface px-3.5 py-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/**
 * `frozen` vem do servidor (voting_released_at). Quando congelado, os
 * campos de COMPOSIÇÃO viram texto com input oculto: continuam sendo
 * enviados com o valor gravado, então a Server Action — que recusa
 * qualquer divergência — nunca barra quem está só trocando o vídeo.
 * Esconder não é o controle; o controle é a recusa no servidor.
 */
export function CandidateForm({
  candidate,
  positions,
  frozen = false,
}: {
  candidate: AdminCandidate | null;
  positions: Position[];
  frozen?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(upsertCandidateAction, initialState);
  const positionName = (id: string) => positions.find((p) => p.id === id)?.name ?? "—";

  return (
    <form action={formAction} className="space-y-5" encType="multipart/form-data">
      {candidate && <input type="hidden" name="id" value={candidate.id} />}

      {frozen && (
        <p className="rounded-md bg-warning-bg px-3.5 py-2.5 text-sm text-warning">
          A votação já foi liberada: nome, cargos, ordem e ativação estão congelados. Foto,
          frase, apresentação, propostas e vídeo continuam editáveis.
        </p>
      )}

      {frozen ? (
        <>
          <input type="hidden" name="full_name" value={candidate?.full_name ?? ""} />
          <input type="hidden" name="position_id_1" value={candidate?.position_ids[0] ?? ""} />
          <input type="hidden" name="position_id_2" value={candidate?.position_ids[1] ?? ""} />
          <input type="hidden" name="display_order" value={candidate?.display_order ?? 0} />
          {candidate?.active && <input type="hidden" name="active" value="on" />}

          <dl className="grid gap-3 rounded-md border border-border bg-surface-muted p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-foreground">Nome completo</dt>
              <dd className="text-foreground-muted">{candidate?.full_name}</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">Cargos</dt>
              <dd className="text-foreground-muted">
                {(candidate?.position_ids ?? []).map(positionName).join(" e ") || "—"}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">Ordem de exibição</dt>
              <dd className="text-foreground-muted">{candidate?.display_order ?? 0}</dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">Situação</dt>
              <dd className="text-foreground-muted">{candidate?.active ? "Ativo" : "Inativo"}</dd>
            </div>
          </dl>
        </>
      ) : (
        <>
      <div>
        <label htmlFor="full_name" className="block text-sm font-medium text-foreground">
          Nome completo
        </label>
        <input
          id="full_name"
          name="full_name"
          defaultValue={candidate?.full_name}
          required
          maxLength={200}
          className={inputClass}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="position_id_1" className="block text-sm font-medium text-foreground">
            Cargo 1
          </label>
          <select
            id="position_id_1"
            name="position_id_1"
            required
            defaultValue={candidate?.position_ids[0] ?? ""}
            className={inputClass}
          >
            <option value="" disabled>
              Selecione
            </option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="position_id_2" className="block text-sm font-medium text-foreground">
            Cargo 2 (opcional)
          </label>
          <select
            id="position_id_2"
            name="position_id_2"
            defaultValue={candidate?.position_ids[1] ?? ""}
            className={inputClass}
          >
            <option value="">Nenhum</option>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
        </>
      )}

      <div>
        <label htmlFor="tagline" className="block text-sm font-medium text-foreground">
          Frase curta (opcional)
        </label>
        <input id="tagline" name="tagline" defaultValue={candidate?.tagline ?? ""} maxLength={200} className={inputClass} />
      </div>

      <div>
        <label htmlFor="presentation" className="block text-sm font-medium text-foreground">
          Apresentação
        </label>
        <textarea
          id="presentation"
          name="presentation"
          defaultValue={candidate?.presentation ?? ""}
          rows={4}
          maxLength={5000}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="proposals" className="block text-sm font-medium text-foreground">
          Propostas
        </label>
        <textarea
          id="proposals"
          name="proposals"
          defaultValue={candidate?.proposals ?? ""}
          rows={4}
          maxLength={5000}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="video_url" className="block text-sm font-medium text-foreground">
          URL do vídeo (YouTube ou Shorts, opcional)
        </label>
        <input
          id="video_url"
          name="video_url"
          type="url"
          defaultValue={candidate?.video_url ?? ""}
          placeholder="https://www.youtube.com/watch?v=... ou .../shorts/..."
          className={inputClass}
          aria-describedby="video_url_ajuda"
        />
        <p id="video_url_ajuda" className="mt-1 text-xs text-foreground-muted">
          Um link <code>/shorts/</code> é exibido em vertical (9:16); os demais, em 16:9.
        </p>
      </div>

      <div>
        <label htmlFor="photo" className="block text-sm font-medium text-foreground">
          Fotografia (JPEG, PNG ou WebP, até 5 MB)
        </label>
        <input
          id="photo"
          name="photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="mt-1.5 block w-full text-sm text-foreground-muted"
        />
      </div>

      {!frozen && (
        <>
          <div>
            <label htmlFor="display_order" className="block text-sm font-medium text-foreground">
              Ordem de exibição
            </label>
            <input
              id="display_order"
              name="display_order"
              type="number"
              min={0}
              defaultValue={candidate?.display_order ?? 0}
              className={`${inputClass} max-w-32`}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="active"
              name="active"
              type="checkbox"
              defaultChecked={candidate?.active ?? true}
              className="h-4 w-4 rounded border-border"
            />
            <label htmlFor="active" className="text-sm text-foreground">
              Candidato ativo (visível publicamente)
            </label>
          </div>
        </>
      )}

      {state.error && (
        <p role="alert" className="rounded-md bg-danger-bg px-3.5 py-3 text-sm text-danger">
          {state.error}
        </p>
      )}

      <div className="flex gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Salvando..." : "Salvar"}
        </Button>
        <Button href="/admin/candidatos" variant="secondary" type="button">
          Cancelar
        </Button>
      </div>
    </form>
  );
}
