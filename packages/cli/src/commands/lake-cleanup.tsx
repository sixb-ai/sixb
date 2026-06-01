import { loadSixbFromEntry } from "../lib/loadSixb"
import { resolveRuntimeEntry } from "../lib/production"
import { stopSixbProviders } from "../lib/runtime"
import { LakeCleanupView, renderStatic } from "../ui"

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
}

export interface LakeMaintenanceReport {
  readonly dryRun: boolean
  readonly expireOlderThan: string
  readonly deleteOlderThan: string
  readonly snapshots: number
  readonly oldFiles: number
  readonly orphanedFiles: number
}

interface LakeMaintenanceProvider {
  runMaintenance(options?: LakeMaintenanceOptions): Promise<LakeMaintenanceReport>
}

export async function runLakeCleanup(options: LakeCleanupOptions = {}) {
  const entry = await resolveRuntimeEntry({ entry: options.entry })
  const sixb = await loadSixbFromEntry(entry)

  try {
    const lakeStorage = sixb.lakeStorage
    if (!isLakeMaintenanceProvider(lakeStorage)) {
      throw new Error("Configured lake storage does not support maintenance cleanup.")
    }

    const expireOlderThan = options.expireOlderThan ?? DEFAULT_RETENTION
    const deleteOlderThan = options.deleteOlderThan ?? expireOlderThan
    const report = await lakeStorage.runMaintenance({
      dryRun: options.dryRun ?? false,
      expireOlderThan,
      deleteOlderThan,
    })
    await renderStatic(
      <LakeCleanupView
        projectId={sixb.id}
        report={report}
        retentionWarning={!report.dryRun && !isDefaultRetention(report)}
      />
    )
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

function isDefaultRetention(report: LakeMaintenanceReport): boolean {
  return (
    report.expireOlderThan === DEFAULT_RETENTION && report.deleteOlderThan === DEFAULT_RETENTION
  )
}
