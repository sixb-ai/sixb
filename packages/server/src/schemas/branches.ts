import { z } from "zod"

export const BranchNameBodySchema = z.object({
  /** The git branch, such as `feature/invoices`. */
  name: z.string().min(1).max(200),
})

export const BranchNameQuerySchema = BranchNameBodySchema

export const BranchSchema = z.object({
  name: z.string(),
  wanted: z.enum(["running", "stopped", "deleted"]),
  state: z.enum(["stopped", "copying", "starting", "ready", "failed"]),
  /** Who opened it: its copy holds what they read in production. */
  createdBy: z.string(),
  generation: z.number().nullable(),
  commit: z.string().nullable(),
  error: z.object({ message: z.string(), file: z.string().optional() }).nullable(),
  /** Why production could not read the repository's branches, while the branch waits for it. */
  remoteError: z.string().nullable(),
  /** What its creator should know: a copy taken anew because its machine was lost, or no dev values. */
  notices: z.array(
    z.object({
      code: z.enum([
        "data-reset",
        "no-dev-env",
        "machine-ended",
        "temp-files-uncapped",
        "database-limit",
        "database-closed",
      ]),
      message: z.string(),
    })
  ),
  /** The copy it runs on: when production took it, and what it left out. */
  data: z
    .object({
      takenAt: z.string(),
      objects: z.number(),
      skipped: z.array(z.object({ objectTypeId: z.string(), reason: z.string() })),
      lakeSliceId: z.string().nullable(),
    })
    .nullable(),
  refreshRequestedAt: z.string().nullable(),
  openedAt: z.string(),
  lastSeenAt: z.string(),
})

export const BranchListResponseSchema = z.object({ branches: z.array(BranchSchema) })
