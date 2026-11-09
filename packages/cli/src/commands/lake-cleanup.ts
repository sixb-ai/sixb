import { parseDurationMs } from "../lib/duration"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"
import { lakeCleanupView, renderStatic, withTask } from "../ui"

const DEFAULT_RETENTION = "7d"

export interface LakeCleanupOptions {
  entry?: string
  dryRun?: boolean
  keepVersionsFor?: string
  deleteFilesAfter?: string
}

export async function runLakeCleanup(options: LakeCleanupOptions = {}) {
  const keepVersionsFor = options.keepVersionsFor ?? DEFAULT_RETENTION
  const deleteFilesAfter = options.deleteFilesAfter ?? DEFAULT_RETENTION
  const keepVersionsForMs = parseDurationMs(keepVersionsFor, "--keep-versions-for")
  const deleteFilesAfterMs = parseDurationMs(deleteFilesAfter, "--delete-files-after")

  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await withTask("lake cleanup", "Loading project", () => loadSixbFromEntry(entry))

  try {
    const maintenance = sixb.lakeStorage.maintenance
    if (maintenance === undefined) {
      throw new Error("[SixbCLI] Configured lake storage does not support retention cleanup.")
    }

    // Objects hold the rows of the version each projection applied, and their markings are read
    // from it: the lake keeps those versions too. Without them, cleanup does not run.
    const applied = await sixb.storage.ontology.sources.listActive({ projectId: sixb.projectId })
    const report = await withTask(
      "lake cleanup",
      options.dryRun ? "Measuring" : "Cleaning up",
      () =>
        maintenance.applyRetention({
          dryRun: options.dryRun ?? false,
          keepVersionsForMs,
          deleteFilesAfterMs,
          protect: applied.map(({ datasetVersion }) => ({
            datasetId: datasetVersion.datasetId,
            versionId: datasetVersion.versionId,
          })),
        })
    )

    await renderStatic(
      lakeCleanupView({ projectId: sixb.id, keepVersionsFor, deleteFilesAfter, report })
    )
  } finally {
    await stopSixbProviders(sixb)
  }
}
