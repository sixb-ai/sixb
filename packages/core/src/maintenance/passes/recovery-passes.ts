import type { LakeStorage } from "../../lake-storage"
import type { MaintenancePass } from "../loop"
import { type IngestPassInput, ingestPass } from "./ingest-pass"
import { LakeChangeFeed } from "./lake-change-feed"
import { type ProjectionsPassInput, projectionsPass } from "./projections-pass"
import { RECOVERY_INTERVAL_MS } from "./recovery-pass"
import { type TriggersPassInput, triggersPass } from "./triggers-pass"

type WithoutShared<T> = Omit<T, "projectId" | "feed" | "lakeStorage">

export interface RecoveryPassesInput {
  readonly projectId: string
  readonly lakeStorage: Pick<LakeStorage, "listLatestVersionsSince"> &
    ProjectionsPassInput["lakeStorage"] &
    TriggersPassInput["lakeStorage"]
  readonly projections?: WithoutShared<ProjectionsPassInput>
  readonly triggers?: WithoutShared<TriggersPassInput>
  /** When the project can ingest. */
  readonly ingest?: Omit<IngestPassInput, "projectId">
}

/**
 * The passes that repair what the event path can lose, sharing one read of the lake's change feed.
 * Whatever has nothing to repair adds no pass, so an idle project pays for none.
 */
export function recoveryPasses(input: RecoveryPassesInput): readonly MaintenancePass[] {
  const { projectId, lakeStorage } = input
  const feed = new LakeChangeFeed({ lakeStorage, projectId, freshForMs: RECOVERY_INTERVAL_MS })

  return [
    input.projections && projectionsPass({ ...input.projections, projectId, lakeStorage, feed }),
    input.triggers && triggersPass({ ...input.triggers, projectId, lakeStorage, feed }),
    input.ingest && ingestPass({ ...input.ingest, projectId }),
  ].filter((pass) => pass !== undefined)
}
