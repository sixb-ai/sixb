import type { SixbBranch } from "../../branch-mode"
import type { LakeStorage } from "../../lake-storage"
import type { MaintenancePass } from "../loop"
import { type IngestPassInput, ingestPass } from "./ingest-pass"
import { LakeChangeFeed } from "./lake-change-feed"
import { type ProjectionsPassInput, projectionsPass } from "./projections-pass"
import { RECOVERY_INTERVAL_MS } from "./recovery-pass"
import { type RunsPassInput, runsPass } from "./runs-pass"
import { type TriggersPassInput, triggersPass } from "./triggers-pass"

type WithoutShared<T> = Omit<T, "projectId" | "feed" | "lakeStorage">

export interface RecoveryPassesInput {
  readonly projectId: string
  /**
   * On a branch whose lake is no fork of production's, the projections pass recovers nothing: the
   * lake cannot tell the branch's versions from the ones its objects were copied from, so a first
   * pass would re-derive every projection and re-create every object the copy holds. A forked lake
   * tells them apart itself (`LakeFork.ownsVersion`). Either way, the live
   * `dataset.version.committed` path still projects what the branch commits.
   */
  readonly branch: SixbBranch | null
  readonly lakeStorage: Pick<LakeStorage, "listLatestVersionsSince"> &
    ProjectionsPassInput["lakeStorage"] &
    TriggersPassInput["lakeStorage"]
  readonly projections?: WithoutShared<ProjectionsPassInput>
  readonly triggers?: WithoutShared<TriggersPassInput>
  /** When the project can ingest. */
  readonly ingest?: Omit<IngestPassInput, "projectId">
  /** When the project has runs a worker can lose. */
  readonly runs?: Omit<RunsPassInput, "projectId">
}

/**
 * The passes that repair what the event path can lose, sharing one read of the lake's change feed.
 * Whatever has nothing to repair adds no pass, so an idle project pays for none.
 */
export function recoveryPasses(input: RecoveryPassesInput): readonly MaintenancePass[] {
  const { projectId, lakeStorage } = input
  const feed = new LakeChangeFeed({ lakeStorage, projectId, freshForMs: RECOVERY_INTERVAL_MS })

  const projections = input.branch && !lakeStorage.fork ? undefined : input.projections

  return [
    projections && projectionsPass({ ...projections, projectId, lakeStorage, feed }),
    input.triggers && triggersPass({ ...input.triggers, projectId, lakeStorage, feed }),
    input.ingest && ingestPass({ ...input.ingest, projectId }),
    input.runs && runsPass({ ...input.runs, projectId }),
  ].filter((pass) => pass !== undefined)
}
