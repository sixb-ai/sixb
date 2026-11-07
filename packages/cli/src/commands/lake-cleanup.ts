import { getLakeRetentionRuntime } from "@sixb/core/internal/runtime"
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
    if (sixb.lakeStorage.maintenance === undefined) {
      throw new Error("[SixbCLI] Configured lake storage does not support retention cleanup.")
    }

    // The same passes as the scheduled retention, without its time budget: they keep the versions
    // projections applied, and run until none reports more. A dry run measures one pass.
    const report = await withTask(
      "lake cleanup",
      options.dryRun ? "Measuring" : "Cleaning up",
      () =>
        getLakeRetentionRuntime(sixb).apply({
          dryRun: options.dryRun ?? false,
          keepVersionsForMs,
          deleteFilesAfterMs,
        })
    )

    await renderStatic(
      lakeCleanupView({ projectId: sixb.id, keepVersionsFor, deleteFilesAfter, report })
    )
  } finally {
    await stopSixbProviders(sixb)
  }
}
