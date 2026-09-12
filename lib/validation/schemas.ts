import { z } from "zod";

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

export const youtubeUrlSchema = z
  .string()
  .trim()
  .regex(
    /^https:\/\/(www\.)?youtube\.com\/|^https:\/\/youtu\.be\//,
    "URL precisa ser do YouTube",
  );

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
    position_ids: z.array(z.string().uuid()).min(1).max(2),
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

export const runoffCreateSchema = z
  .object({
    position_id: z.string().uuid(),
    candidate_ids: z.array(z.string().uuid()).min(2).max(20),
    votes_per_voter: z.number().int().min(1).max(20),
    vacancies: z.number().int().min(1).max(20),
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
