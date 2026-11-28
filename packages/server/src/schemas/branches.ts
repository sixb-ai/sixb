import { SNAPSHOT_SKIP_KINDS } from "@sixb/core/internal/snapshots"
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
      skipped: z.array(
        z.object({
          objectTypeId: z.string(),
          kind: z.enum(SNAPSHOT_SKIP_KINDS),
          reason: z.string(),
          /** The lines a deploy of the branch's code prints for it. */
          findings: z.array(z.string()),
        })
      ),
      /** Types its creator reads only in part: the branch's migrations ran on the rest. */
      partial: z.array(
        z.object({
          objectTypeId: z.string(),
          hiddenPropertyIds: z.array(z.string()),
          throughCondition: z.boolean(),
        })
      ),
      /** What a deploy of the branch's code would refuse in what the copy held, left out of it. */
      refusedByDeploy: z.array(
        z.object({ objectTypeId: z.string(), findings: z.array(z.string()) })
      ),
      /**
       * What a deploy would check that the copy can't: values hidden from its creator, or of keys
       * production's code no longer declares, which never travel.
       */
      unchecked: z.array(z.object({ objectTypeId: z.string(), lines: z.array(z.string()) })),
      /** The branch's migrations the copy ran, by type. */
      migrated: z.array(z.object({ objectTypeId: z.string(), migrationIds: z.array(z.string()) })),
      /** Datasets left out: their creator may not read every column. */
      skippedDatasets: z.array(
        z.object({
          datasetId: z.string(),
          reason: z.enum(["missing_clearance"]),
          columns: z.array(z.string()),
        })
      ),
      lakeSliceId: z.string().nullable(),
    })
    .nullable(),
  refreshRequestedAt: z.string().nullable(),
  openedAt: z.string(),
  lastSeenAt: z.string(),
})

export const BranchListResponseSchema = z.object({
  branches: z.array(BranchSchema),
  /** What production lacks to run branches, or null when it can. */
  unavailable: z
    .object({
      code: z.enum([
        "storage",
        "source",
        "sandboxes",
        "sandbox-shares-host",
        "preview-domain",
        "sandbox-env",
      ]),
      message: z.string(),
    })
    .nullable(),
  /** Production's time as it answered: how long a branch has waited, whatever the reader's clock. */
  now: z.string(),
})

export const BranchSignInResponseSchema = z.object({
  /** On the branch's own origin: open it within a minute, once. */
  url: z.string(),
})
