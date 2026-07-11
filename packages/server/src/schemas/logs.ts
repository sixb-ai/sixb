import { LOG_LEVELS, LOG_RUN_KINDS } from "@sixb/core"
import { z } from "zod"

export { LOG_LEVELS, LOG_RUN_KINDS }

export const LogRunKindSchema = z.enum(LOG_RUN_KINDS)
export const LogLevelSchema = z.enum(LOG_LEVELS)
export const LogRunIdSchema = z.string().regex(/\S/, "run id must not be blank")
export const DEFAULT_LOGS_PAGE_LIMIT = 200
export const MAX_LOGS_PAGE_LIMIT = 1_000

const LogsLimitSchema = z.coerce.number().int().positive().max(MAX_LOGS_PAGE_LIMIT)

export const LogsQuerySchema = z
  .object({
    kind: LogRunKindSchema.optional(),
    runId: LogRunIdSchema.optional(),
    level: LogLevelSchema.optional(),
    direction: z.enum(["forward", "backward"]).optional(),
    afterCursor: z.string().optional(),
    beforeCursor: z.string().optional(),
    limit: LogsLimitSchema.optional(),
  })
  .superRefine((query, context) => {
    if (query.runId !== undefined && query.kind === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runId"],
        message: "kind is required when runId is provided",
      })
    }
    if (query.afterCursor && query.beforeCursor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "afterCursor and beforeCursor are mutually exclusive",
      })
    }
    if (query.direction === "backward" && query.afterCursor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["afterCursor"],
        message: "afterCursor cannot be used with backward reads",
      })
    }
    if (query.direction !== "backward" && query.beforeCursor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["beforeCursor"],
        message: "beforeCursor requires direction=backward",
      })
    }
  })

export const LogLineSchema = z.object({
  level: LogLevelSchema,
  message: z.string(),
  fields: z.record(z.unknown()).optional(),
  at: z.string(),
  context: z.object({
    run: z.object({
      kind: LogRunKindSchema,
      id: z.string(),
    }),
    stepId: z.string().optional(),
    phase: z.string().optional(),
    attempt: z.number().optional(),
  }),
  cursor: z.string(),
})

export const LogsResponseSchema = z.object({
  count: z.number(),
  lines: z.array(LogLineSchema),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
})
