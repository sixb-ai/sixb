import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"
import { lakeCleanupView, renderStatic, withTask } from "../ui"

const DEFAULT_RETENTION = "7 days"

export interface LakeCleanupOptions {
  entry?: string
  dryRun?: boolean
  expireOlderThan?: string
  deleteOlderThan?: string
}

interface LakeMaintenanceOptions {
  readonly dryRun?: boolean
  readonly expireOlderThan?: string
  readonly deleteOlderThan?: string
  readonly protect?: readonly { readonly datasetId: string; readonly versionId: string }[]
}

export interface LakeMaintenanceReport {
  readonly dryRun: boolean
  readonly expireOlderThan: string
  readonly deleteOlderThan: string
  readonly snapshots: number
  /** Old snapshots kept because a version they hold is still needed, when the provider says. */
  readonly keptSnapshots?: number
  readonly oldFiles: number
  readonly orphanedFiles: number
}

interface LakeMaintenanceProvider {
  runMaintenance(options?: LakeMaintenanceOptions): Promise<LakeMaintenanceReport>
}

export async function runLakeCleanup(options: LakeCleanupOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await withTask("lake cleanup", "Loading project", () => loadSixbFromEntry(entry))

  try {
    const lakeStorage = sixb.lakeStorage
    if (!isLakeMaintenanceProvider(lakeStorage)) {
      throw new Error("Configured lake storage does not support maintenance cleanup.")
    }

    const expireOlderThan = options.expireOlderThan ?? DEFAULT_RETENTION
    const deleteOlderThan = options.deleteOlderThan ?? expireOlderThan

    // Objects hold the rows of the version each projection applied, and their markings are read
    // from it: the lake keeps those versions too. Without them, cleanup does not run.
    const applied = await sixb.storage.ontology.sources.listActive({ projectId: sixb.projectId })
    const report = await withTask(
      "lake cleanup",
      options.dryRun ? "Measuring" : "Cleaning up",
      () =>
        lakeStorage.runMaintenance({
          dryRun: options.dryRun ?? false,
          expireOlderThan,
          deleteOlderThan,
          protect: applied.map(({ datasetVersion }) => ({
            datasetId: datasetVersion.datasetId,
            versionId: datasetVersion.versionId,
          })),
        })
    )
    await renderStatic(lakeCleanupView({ projectId: sixb.id, report }))
  } finally {
    await stopSixbProviders(sixb)
  }
}

function isLakeMaintenanceProvider(value: unknown): value is LakeMaintenanceProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { runMaintenance?: unknown }).runMaintenance === "function"
  )
}
