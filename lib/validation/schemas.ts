import { z } from "zod";
import { isSupportedYouTubeUrl } from "@/lib/media/youtube";

export const voterValidationSchema = z
  .object({
    registration_number: z.string().trim().min(1).max(50),
    full_name: z.string().trim().min(1).max(200),
  })
  .strict();

export const ballotAllocationSchema = z
  .object({
    candidate_id: z.string().uuid().nullable(),
    is_null_vote: z.boolean(),
    quantity: z.number().int().min(0).max(50),
  })
  .strict();

export const ballotPositionSchema = z
  .object({
    position_id: z.string().uuid(),
    allocations: z.array(ballotAllocationSchema).min(1).max(20),
  })
  .strict();

export const ballotSubmitSchema = z
  .object({
    positions: z.array(ballotPositionSchema).min(1).max(20),
  })
  .strict();

export const adminLoginSchema = z
  .object({
    password: z.string().min(1).max(200),
  })
  .strict();

/**
 * Valida com o MESMO parser que o player usa para exibir.
 *
 * Antes bastava a URL começar com youtube.com: um link de Short passava na
 * validação, era gravado e depois sumia da tela, porque o player não sabia
 * lê-lo. Aceitar e conseguir exibir passam a ser a mesma pergunta.
 */
export const youtubeUrlSchema = z
  .string()
  .trim()
  .refine(isSupportedYouTubeUrl, "Use um link válido do YouTube ou YouTube Shorts.");

export const candidateUpsertSchema = z
  .object({
    id: z.string().uuid().optional(),
    full_name: z.string().trim().min(1).max(200),
    tagline: z.string().trim().max(200).optional().nullable(),
    presentation: z.string().trim().max(5000).optional().nullable(),
    proposals: z.string().trim().max(5000).optional().nullable(),
    video_url: z.union([youtubeUrlSchema, z.literal("")]).optional().nullable(),
    active: z.boolean(),
    display_order: z.number().int().min(0).max(9999),
    // `.refine` e não só `.max(2)`: [A,A] tem tamanho 2 e passaria. O
    // duplicado quebrava o índice único de candidate_positions DEPOIS do
    // DELETE dos vínculos antigos, deixando o candidato sem cargo nenhum.
    position_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(2)
      .refine((ids) => new Set(ids).size === ids.length, "Escolha dois cargos diferentes."),
  })
  .strict();

export const scheduleUpdateSchema = z
  .object({
    phase_key: z.enum([
      "edital",
      "candidaturas",
      "divulgacao_candidaturas",
      "apresentacao",
      "envio_videos",
      "votacao",
      "apuracao",
      "divulgacao_resultados",
    ]),
    starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  })
  .strict();

// Candidatos, vagas em disputa e votos por eleitor NÃO vêm do formulário:
// são derivados de result_snapshots dentro de create_runoff_election. O
// navegador informa apenas quais cargos e quando.
export const runoffCreateSchema = z
  .object({
    position_ids: z.array(z.string().uuid()).min(1).max(20),
    reason: z.string().trim().min(1).max(500),
    starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  })
  .strict();

export const dualWinnerDecisionSchema = z
  .object({
    decision_id: z.string().uuid(),
    chosen_position_id: z.string().uuid(),
  })
  .strict();
