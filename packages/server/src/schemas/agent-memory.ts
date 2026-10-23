import { z } from "zod"
import { ErrorResponseSchema, PrincipalSchema } from "./common"

const AgentMemoryFileSchema = z.object({
  path: z.string().describe("The file's path from the repo root, such as projects/payments.md"),
  contents: z.string(),
})

const AgentMemoryChangeSchema = z.object({
  path: z.string().min(1).describe("The file's path from the repo root"),
  contents: z.string().nullable().describe("The file's new contents, or null to delete it"),
})

export const AgentMemoryParamsSchema = z.object({
  repo: z
    .enum(["user", "project"])
    .describe("user: the caller's own memory. project: the memory the whole project shares."),
})

export const AgentMemoryRepoResponseSchema = z.object({
  repo: z.enum(["user", "project"]),
  revision: z.number().int().nonnegative().describe("0 before the first save"),
  files: z.array(AgentMemoryFileSchema).describe("Ordered by path"),
})

export const AgentMemoryRepoQuerySchema = z
  .object({
    revision: z
      .string()
      .regex(/^\d+$/)
      .optional()
      .describe("Read the repo as this revision left it, such as one listed in its history"),
  })
  .strict()

export const AgentMemoryRevisionListQuerySchema = z
  .object({ limit: z.string().optional(), offset: z.string().optional() })
  .strict()

export const AgentMemoryRevisionListResponseSchema = z.object({
  revisions: z
    .array(
      z.object({
        revision: z.number().int().positive(),
        message: z.string(),
        author: PrincipalSchema,
        source: z.string().optional().describe("The conversation the save came from"),
        changes: z
          .array(z.object({ path: z.string(), deleted: z.boolean() }))
          .describe("The paths the revision wrote, ordered by path"),
        createdAt: z.string(),
      })
    )
    .describe("Newest first"),
  hasMore: z.boolean(),
  total: z.number().int(),
})

export const SaveAgentMemoryBodySchema = z
  .object({
    baseRevision: z
      .number()
      .int()
      .nonnegative()
      .describe("The revision the changes were made against"),
    message: z.string().describe("What was learned, as the revision's entry in the history"),
    changes: z.array(AgentMemoryChangeSchema).min(1),
  })
  .strict()

export const SavedAgentMemoryResponseSchema = z.object({
  repo: z.enum(["user", "project"]),
  revision: z.number().int().positive(),
  warnings: z
    .array(z.object({ path: z.string(), link: z.string() }))
    .describe("Links in the saved repo that point at no file"),
})

export const AgentMemoryErrorResponseSchema = ErrorResponseSchema.extend({
  code: z
    .string()
    .optional()
    .describe(
      "Stable machine-readable failure code: invalid_save, not_allowed, conflict, or storage_unavailable."
    ),
})

export const AgentMemoryConflictResponseSchema = ErrorResponseSchema.extend({
  code: z.literal("conflict"),
  revision: z.number().int().nonnegative().describe("The repo's latest revision"),
  conflicts: z
    .array(AgentMemoryChangeSchema)
    .describe("Files another save changed after the base revision, as they are now"),
})

export const DeleteAgentMemoryResponseSchema = z.object({ deleted: z.literal(true) })
