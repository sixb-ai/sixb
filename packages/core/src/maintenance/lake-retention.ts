import type {
  DatasetVersionRef,
  LakeMaintenance,
  LakeRetentionReport,
  LakeStorage,
} from "../lake-storage"
import { RuntimeError } from "../runtime/errors"
import { parseDuration } from "../shared/duration"
import type { LakeRetentionRunRecord, Storage } from "../storage"
import type { OntologySourceStorage } from "../storage/ontology/sources"
import { type LakeRetentionStatus, lakeRetentionStatus } from "./lake-retention-status"

/** Automatic retention of replaced dataset versions and the files only they read. */
export interface LakeMaintenanceOptions {
  /** Run retention automatically. Default: true. */
  readonly enabled?: boolean
  /** How long a version stays readable once a newer one replaced it. Default: "7d", at least "1h". */
  readonly keepVersionsFor?: string
  /** How long a file no kept version reads stays in storage. Default: "7d", at least "1h". */
  readonly deleteFilesAfter?: string
  /** How often retention runs, such as "15m", "6h" or "1d". Default: "1h". */
  readonly cleanupEvery?: string
}

export interface LakeMaintenanceSettings {
  readonly enabled: boolean
  readonly keepVersionsFor: string
  readonly keepVersionsForMs: number
  readonly deleteFilesAfter: string
  readonly deleteFilesAfterMs: number
  readonly cleanupEvery: string
  readonly cleanupEveryMs: number
}

export interface LakeRetentionPassOptions {
  readonly keepVersionsForMs: number
  readonly deleteFilesAfterMs: number
  /** One pass that changes nothing. */
  readonly dryRun?: boolean
  /** Starts no pass once this long has passed since the first one. */
  readonly budgetMs?: number
  readonly signal?: AbortSignal
}

/** Internal entry point for the worker, the CLI and the API. */
export interface LakeRetentionRuntime {
  readonly settings: LakeMaintenanceSettings
  /** Whether retention runs on its own: enabled, a provider with maintenance, and datasets. */
  readonly automatic: boolean
  /** Null when the lake storage provider has no maintenance. */
  readonly maintenance: LakeMaintenance | null
  /**
   * Runs passes while one reports more to do, protecting the versions projections applied as they
   * are at each pass. A dry run is one pass. The report adds the passes up.
   */
  apply(options: LakeRetentionPassOptions): Promise<LakeRetentionReport>
  /**
   * Runs what the `lake-retention` pass requested for the interval starting at `intervalStart`,
   * within a budget, and records it. Null when retention was turned off since, or the interval is
   * over: the next request covers it, so a backlog left by a stopped worker runs once.
   */
  runRequested(intervalStart: string, signal: AbortSignal): Promise<LakeRetentionReport | null>
  /** What durable state says about automatic retention, whichever process asks. */
  status(): Promise<LakeRetentionStatus>
}

const DEFAULT_RETENTION = "7d"
const DEFAULT_CLEANUP_EVERY = "1h"
// The provider's floor for both: a version a reader just resolved, and a file a write in another
// process put in the data path before committing, stay this long whatever the settings.
const MIN_RETENTION_MS = 60 * 60_000

// A pass that finds more to do starts the next one after this pause, so a long backlog leaves the
// catalog room for the writes that run beside it.
const PASS_PAUSE_MS = 1_000

// A requested run never holds a worker for longer: the next interval's run continues.
const MAX_RUN_BUDGET_MS = 10 * 60_000

export function resolveLakeMaintenanceSettings(
  options: LakeMaintenanceOptions | undefined
): LakeMaintenanceSettings {
  const enabled = options?.enabled ?? true
  if (typeof enabled !== "boolean") {
    throw new RuntimeError("[Sixb] lakeMaintenance.enabled must be true or false.")
  }

  const keepVersionsFor = options?.keepVersionsFor ?? DEFAULT_RETENTION
  const keepVersionsForMs = retentionOption("keepVersionsFor", keepVersionsFor)

  const deleteFilesAfter = options?.deleteFilesAfter ?? DEFAULT_RETENTION
  const deleteFilesAfterMs = retentionOption("deleteFilesAfter", deleteFilesAfter)

  const cleanupEvery = options?.cleanupEvery ?? DEFAULT_CLEANUP_EVERY
  const cleanupEveryMs = durationOption("cleanupEvery", cleanupEvery)

  return {
    enabled,
    keepVersionsFor,
    keepVersionsForMs,
    deleteFilesAfter,
    deleteFilesAfterMs,
    cleanupEvery,
    cleanupEveryMs,
  }
}

export function createLakeRetentionRuntime(input: {
  readonly projectId: string
  readonly options: LakeMaintenanceOptions | undefined
  readonly lakeStorage: Pick<LakeStorage, "maintenance">
  readonly storage: Pick<Storage, "lakeRetentionRuns" | "maintenanceHeartbeats">
  readonly sources: Pick<OntologySourceStorage, "listActive">
  readonly datasetCount: number
}): LakeRetentionRuntime {
  const settings = resolveLakeMaintenanceSettings(input.options)
  const maintenance = input.lakeStorage.maintenance ?? null

  if (input.options?.enabled === true && maintenance === null) {
    throw new RuntimeError(
      "[Sixb] lakeMaintenance.enabled is true, but the lake storage provider has no maintenance. " +
        "Remove the option, or use a provider that supports it, such as DuckLake."
    )
  }

  // Syncs, pipelines and the SDK write registered datasets only, so a project without datasets
  // writes nothing to the lake.
  const automatic = settings.enabled && maintenance !== null && input.datasetCount > 0

  // Objects hold the rows of the version each projection applied, and their markings are read
  // from it: the lake keeps those versions too. Read before every pass, since a projection may
  // apply a version between two of them.
  const protect = async (): Promise<readonly DatasetVersionRef[]> => {
    const applied = await input.sources.listActive({ projectId: input.projectId })

    return applied.map(({ datasetVersion }) => ({
      datasetId: datasetVersion.datasetId,
      versionId: datasetVersion.versionId,
    }))
  }

  const apply = async (options: LakeRetentionPassOptions): Promise<LakeRetentionReport> => {
    if (maintenance === null) {
      throw new RuntimeError("[Sixb] The lake storage provider has no maintenance.")
    }

    return runRetentionPasses({ maintenance, protect, options })
  }

  // The run happened whatever this says, so a failed write costs the Console its account, no more.
  const recordRun = async (run: Omit<LakeRetentionRunRecord, "projectId">): Promise<void> => {
    const { projectId } = input

    await input.storage.lakeRetentionRuns
      ?.record({ ...run, projectId })
      .catch((failure: unknown) => {
        console.error("[Sixb] Could not record a lake retention run:", failure)
      })
  }

  return {
    settings,
    automatic,
    maintenance,
    apply,

    async runRequested(intervalStart, signal) {
      const intervalOver = Date.now() - Date.parse(intervalStart) >= settings.cleanupEveryMs
      if (!automatic || intervalOver) return null

      const startedAt = new Date()
      await recordRun({ startedAt, finishedAt: null, failed: false })

      const finish = (failed: boolean) => recordRun({ startedAt, finishedAt: new Date(), failed })

      try {
        const report = await apply({
          keepVersionsForMs: settings.keepVersionsForMs,
          deleteFilesAfterMs: settings.deleteFilesAfterMs,
          budgetMs: Math.min(settings.cleanupEveryMs / 2, MAX_RUN_BUDGET_MS),
          signal,
        })
        await finish(false)

        return report
      } catch (error) {
        // Shutdown returns the job to the queue: that is no failed run.
        await finish(!signal.aborted)
        throw error
      }
    },

    async status() {
      const projectId = input.projectId
      const [heartbeat, lastRun] = await Promise.all([
        input.storage.maintenanceHeartbeats?.get({ projectId }) ?? null,
        input.storage.lakeRetentionRuns?.getLast({ projectId }) ?? null,
      ])

      return lakeRetentionStatus({ settings, automatic, heartbeat, lastRun, now: new Date() })
    },
  }
}

// Associates each host with its runtime, as the vector indexing runtime does.
const runtimes = new WeakMap<object, LakeRetentionRuntime>()

export function registerLakeRetentionRuntime(host: object, runtime: LakeRetentionRuntime): void {
  runtimes.set(host, runtime)
}

export function getLakeRetentionRuntime(host: object): LakeRetentionRuntime {
  const runtime = runtimes.get(host)
  if (!runtime) {
    throw new Error("[Sixb] Lake retention requires a configured Sixb host.")
  }

  return runtime
}

async function runRetentionPasses(input: {
  readonly maintenance: LakeMaintenance
  readonly protect: () => Promise<readonly DatasetVersionRef[]>
  readonly options: LakeRetentionPassOptions
}): Promise<LakeRetentionReport> {
  const { maintenance, protect, options } = input
  const startedAt = Date.now()
  let total: LakeRetentionReport | undefined

  for (;;) {
    options.signal?.throwIfAborted()

    const report = await maintenance.applyRetention({
      keepVersionsForMs: options.keepVersionsForMs,
      deleteFilesAfterMs: options.deleteFilesAfterMs,
      dryRun: options.dryRun ?? false,
      protect: await protect(),
      signal: options.signal,
    })
    total = total === undefined ? report : addReports(total, report)

    if (!report.hasMore || options.dryRun) {
      return total
    }

    const budgetSpent = options.budgetMs !== undefined && Date.now() - startedAt >= options.budgetMs
    if (budgetSpent) {
      return total
    }

    await pause(PASS_PAUSE_MS, options.signal)
  }
}

function addReports(total: LakeRetentionReport, pass: LakeRetentionReport): LakeRetentionReport {
  return {
    ...pass,
    expiredVersions: total.expiredVersions + pass.expiredVersions,
    keptVersions: pass.keptVersions,
    deletedFiles: total.deletedFiles + pass.deletedFiles,
    orphanedFiles: total.orphanedFiles + pass.orphanedFiles,
  }
}

function retentionOption(field: "keepVersionsFor" | "deleteFilesAfter", value: string): number {
  const durationMs = durationOption(field, value)
  if (durationMs < MIN_RETENTION_MS) {
    throw new RuntimeError(
      `[Sixb] lakeMaintenance.${field} must be at least 1h; received "${value}".`
    )
  }

  return durationMs
}

function durationOption(field: keyof LakeMaintenanceOptions, value: unknown): number {
  const durationMs = typeof value === "string" ? parseDuration(value) : null
  if (durationMs === null || durationMs <= 0) {
    throw new RuntimeError(
      `[Sixb] lakeMaintenance.${field} must be a duration such as 30m, 12h or 7d; received ${JSON.stringify(value)}.`
    )
  }

  return durationMs
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
