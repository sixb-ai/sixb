import { getLakeRetentionRuntime } from "@sixb/core/internal/runtime"
import { parseDurationMs } from "../lib/duration"
import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"
import { lakeCleanupView, renderStatic, withTask } from "../ui"

export interface LakeCleanupOptions {
  entry?: string
  dryRun?: boolean
  keepVersionsFor?: string
  deleteFilesAfter?: string
}

export async function runLakeCleanup(options: LakeCleanupOptions = {}) {
  const keepVersions = durationFlag(options.keepVersionsFor, "--keep-versions-for")
  const deleteFiles = durationFlag(options.deleteFilesAfter, "--delete-files-after")

  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await withTask("lake cleanup", "Loading project", () => loadSixbFromEntry(entry))

  try {
    if (sixb.lakeStorage.maintenance === undefined) {
      throw new Error("[SixbCLI] Configured lake storage does not support retention cleanup.")
    }

    const retention = getLakeRetentionRuntime(sixb)
    const { settings } = retention
    const keepVersionsFor = options.keepVersionsFor ?? settings.keepVersionsFor
    const deleteFilesAfter = options.deleteFilesAfter ?? settings.deleteFilesAfter

    // The same passes as automatic retention, without its time budget: they keep the versions
    // projections applied, and run until none reports more. A dry run measures one pass.
    const report = await withTask(
      "lake cleanup",
      options.dryRun ? "Measuring" : "Cleaning up",
      () =>
        retention.apply({
          dryRun: options.dryRun ?? false,
          keepVersionsForMs: keepVersions ?? settings.keepVersionsForMs,
          deleteFilesAfterMs: deleteFiles ?? settings.deleteFilesAfterMs,
        })
    )

    await renderStatic(
      lakeCleanupView({ projectId: sixb.id, keepVersionsFor, deleteFilesAfter, report })
    )
  } finally {
    await stopSixbProviders(sixb)
  }
}

/** Read before anything loads, so that a typo fails at once. */
function durationFlag(value: string | undefined, flag: string): number | null {
  return value === undefined ? null : parseDurationMs(value, flag)
}
