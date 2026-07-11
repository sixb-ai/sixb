import type { LogLevel, LogRunKind } from "@sixb/core"
import { z } from "zod"

// `satisfies` pins these literals to the core unions, so a new run kind or log
// level in `@sixb/core` fails the build here until the wire schema catches up.
export const LOG_RUN_KINDS = [
  "sync",
  "pipeline",
  "workflow",
  "action",
] as const satisfies readonly LogRunKind[]
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const satisfies readonly LogLevel[]

export const LogRunKindSchema = z.enum(LOG_RUN_KINDS)
export const LogLevelSchema = z.enum(LOG_LEVELS)

export const LogsQuerySchema = z
  .object({
    kind: LogRunKindSchema.optional(),
    runId: z.string().optional(),
    level: LogLevelSchema.optional(),
    direction: z.enum(["forward", "backward"]).optional(),
    afterCursor: z.string().optional(),
    beforeCursor: z.string().optional(),
    limit: z.string().optional(),
  })
  .superRefine((query, context) => {
    if (query.runId && !query.kind) {
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
