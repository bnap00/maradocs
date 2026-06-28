import { z } from "zod";
import { ACCESS_MODES } from "./constants.js";
import { SLUG_PATTERN } from "./slug.js";

export const accessModeSchema = z.enum(ACCESS_MODES);

export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(SLUG_PATTERN, "must be lowercase alphanumeric with single hyphens");

export const createRepoSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  access: accessModeSchema.optional(),
  indexEnabled: z.boolean().optional(),
  /** Required when access is "password". */
  password: z.string().min(4).max(256).optional(),
});
export type CreateRepoInput = z.infer<typeof createRepoSchema>;

export const updateRepoSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  access: accessModeSchema.optional(),
  indexEnabled: z.boolean().optional(),
  /** Set to a string to (re)set the password; null clears it. */
  password: z.string().min(4).max(256).nullable().optional(),
});
export type UpdateRepoInput = z.infer<typeof updateRepoSchema>;

export const publishDocSchema = z.object({
  doc: slugSchema,
  title: z.string().min(1).max(160).optional(),
  access: accessModeSchema.optional(),
  password: z.string().min(4).max(256).optional(),
  entrypoint: z.string().min(1).max(200).optional(),
});
export type PublishDocInput = z.infer<typeof publishDocSchema>;

export const rollbackSchema = z.object({
  version: z.number().int().positive(),
});
export type RollbackInput = z.infer<typeof rollbackSchema>;

export const passwordUnlockSchema = z.object({
  password: z.string().min(1).max(256),
});

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
