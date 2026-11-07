import type {
  DatasetVersionRef,
  LakeMaintenance,
  LakeRetentionReport,
  LakeStorage,
} from "../lake-storage"
import { RuntimeError } from "../runtime/errors"
import { defineSchedule } from "../schedules/builders"
import type { CronScheduleDefinition } from "../schedules/types"
import { parseDuration } from "../shared/duration"
import type { OntologySourceStorage } from "../storage/ontology/sources"

/** Automatic retention of replaced dataset versions and the files only they read. */
export interface LakeMaintenanceOptions {
  /** Run retention on a schedule. Default: true. */
  readonly enabled?: boolean
  /** How long a version stays readable once a newer one replaced it. Default: "7d", at least "1h". */
  readonly keepVersionsFor?: string
  /** How long a file no kept version reads stays in storage. Default: "7d", at least "1h". */
  readonly deleteFilesAfter?: string
  /** How often retention runs: a duration that divides an hour or a day. Default: "1h". */
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

/** Internal entry point for the worker, the CLI and the API; it never exposes the providers. */
export interface LakeRetentionRuntime {
  readonly settings: LakeMaintenanceSettings
  /** Whether the built-in schedule runs: enabled, a provider with maintenance, and datasets. */
  readonly scheduled: boolean
  /** Null when the lake storage provider has no maintenance. */
  readonly maintenance: LakeMaintenance | null
  /**
   * Runs passes while one reports more to do, protecting the versions projections applied as they
   * are at each pass. A dry run is one pass. The report adds the passes up.
   */
  apply(options: LakeRetentionPassOptions): Promise<LakeRetentionReport>
  /**
   * Runs one occurrence of the built-in schedule within its budget. Null when the occurrence is
   * older than one interval: a later one covers it, so a backlog of occurrences runs once.
   */
  runOccurrence(occurrenceAt: string, signal: AbortSignal): Promise<LakeRetentionReport | null>
}

/** The built-in schedule's id. A project's own schedule cannot take it. */
export const LAKE_RETENTION_SCHEDULE_ID = "sixb:lake-retention"

const DEFAULT_RETENTION = "7d"
const DEFAULT_CLEANUP_EVERY = "1h"
// The provider's floor for both: a version a reader just resolved, and a file a write in another
// process put in the data path before committing, stay this long whatever the settings.
const MIN_RETENTION_MS = 60 * 60_000

// A pass that finds more to do starts the next one after this pause, so a long backlog leaves the
// catalog room for the writes that run beside it.
const PASS_PAUSE_MS = 1_000

// One occurrence never holds a worker for longer: the next occurrence continues.
const MAX_OCCURRENCE_BUDGET_MS = 10 * 60_000

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

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
  cleanupCron(cleanupEvery, cleanupEveryMs)

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

/** The schedule that requests retention every `cleanupEvery`, in the project's time zone. */
export function lakeRetentionSchedule(settings: LakeMaintenanceSettings): CronScheduleDefinition {
  return defineSchedule(LAKE_RETENTION_SCHEDULE_ID).cron(
    cleanupCron(settings.cleanupEvery, settings.cleanupEveryMs)
  )
}

export function createLakeRetentionRuntime(input: {
  readonly projectId: string
  readonly options: LakeMaintenanceOptions | undefined
  readonly lakeStorage: Pick<LakeStorage, "maintenance">
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
  const scheduled = settings.enabled && maintenance !== null && input.datasetCount > 0

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

  return {
    settings,
    scheduled,
    maintenance,
    apply,

    async runOccurrence(occurrenceAt, signal) {
      const occurrenceMs = Date.parse(occurrenceAt)
      if (Number.isNaN(occurrenceMs)) {
        throw new RuntimeError(`[Sixb] Lake retention occurrence '${occurrenceAt}' is not a date.`)
      }

      if (Date.now() - occurrenceMs > settings.cleanupEveryMs) {
        return null
      }

      return apply({
        keepVersionsForMs: settings.keepVersionsForMs,
        deleteFilesAfterMs: settings.deleteFilesAfterMs,
        budgetMs: Math.min(settings.cleanupEveryMs / 2, MAX_OCCURRENCE_BUDGET_MS),
        signal,
      })
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

/**
 * Cron only fires at minutes, hours and weekdays, so the interval has to divide an hour or a day,
 * or be a week. Anything else would drift against the clock.
 */
function cleanupCron(cleanupEvery: string, cleanupEveryMs: number): string {
  if (cleanupEveryMs < HOUR_MS && HOUR_MS % cleanupEveryMs === 0) {
    const minutes = cleanupEveryMs / MINUTE_MS
    return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`
  }

  if (cleanupEveryMs < DAY_MS && DAY_MS % cleanupEveryMs === 0 && cleanupEveryMs % HOUR_MS === 0) {
    const hours = cleanupEveryMs / HOUR_MS
    return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`
  }

  if (cleanupEveryMs === DAY_MS) {
    return "0 0 * * *"
  }

  if (cleanupEveryMs === WEEK_MS) {
    return "0 0 * * 1"
  }

  throw new RuntimeError(
    `[Sixb] lakeMaintenance.cleanupEvery must divide an hour or a day, such as 15m, 1h, 6h or 1d; received "${cleanupEvery}".`
  )
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
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
