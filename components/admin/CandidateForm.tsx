"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { upsertCandidateAction, type CandidateFormState } from "@/app/admin/(protected)/candidatos/actions";
import type { AdminCandidate } from "@/lib/admin/candidates";
import type { Position } from "@/lib/election/positions";

const initialState: CandidateFormState = { error: null };

const inputClass =
  "mt-1.5 block w-full rounded-md border border-border bg-surface px-3.5 py-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export function CandidateForm({
  candidate,
  positions,
}: {
  candidate: AdminCandidate | null;
  positions: Position[];
}) {
  const [state, formAction, isPending] = useActionState(upsertCandidateAction, initialState);

  return (
    <form action={formAction} className="space-y-5" encType="multipart/form-data">
      {candidate && <input type="hidden" name="id" value={candidate.id} />}

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
          URL do vídeo (YouTube, opcional)
        </label>
        <input
          id="video_url"
          name="video_url"
          type="url"
          defaultValue={candidate?.video_url ?? ""}
          placeholder="https://www.youtube.com/watch?v=..."
          className={inputClass}
        />
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
