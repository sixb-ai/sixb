import { z } from "zod"

export const BranchErrorSchema = z.object({
  message: z.string(),
  /** The project file the error points at, relative to the project. */
  file: z.string().optional(),
})

export const BranchSchema = z.object({
  /** The git branch. */
  name: z.string(),
  /** Whether someone wants its runtime running. */
  wanted: z.enum(["running", "stopped"]),
  state: z.enum(["stopped", "starting", "ready", "failed"]),
  /** Each change that reaches the branch starts a new generation of its runtime. */
  generation: z.number().int().nullable(),
  /** The commit its runtime serves. */
  commit: z.string().nullable(),
  /** Its runtime's definitions manifest hash, to compare with production's. */
  manifest: z.string().nullable(),
  error: BranchErrorSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSeenAt: z.string(),
})

export const BranchListSchema = z.object({ branches: z.array(BranchSchema) })

export const OpenBranchBodySchema = z.object({
  /** The git branch, created from the default branch when it doesn't exist yet. */
  name: z.string().min(1).max(200),
})
