import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import type {
  LakeMaintenance,
  LakeRetentionOptions,
  LakeRetentionReport,
} from "../src/lake-storage"
import {
  createLakeRetentionRuntime,
  type LakeMaintenanceOptions,
  lakeRetentionSchedule,
  resolveLakeMaintenanceSettings,
} from "../src/maintenance/lake-retention"
import type { ActiveOntologySource } from "../src/storage/ontology/sources"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = new Date("2026-11-05T10:00:00.000Z")

/** A provider whose passes report more to do `passesWithMore` times, each taking `passMs`. */
function fakeMaintenance(input: { passesWithMore?: number; passMs?: number } = {}) {
  const passes: LakeRetentionOptions[] = []

  const maintenance: LakeMaintenance = {
    async applyRetention(options = {}): Promise<LakeRetentionReport> {
      passes.push(options)
      if (input.passMs) jest.setSystemTime(Date.now() + input.passMs)

      return {
        dryRun: options.dryRun ?? false,
        keepVersionsForMs: options.keepVersionsForMs ?? 0,
        deleteFilesAfterMs: options.deleteFilesAfterMs ?? 0,
        expiredVersions: 2,
        keptVersions: 1,
        deletedFiles: 3,
        orphanedFiles: 1,
        hasMore: passes.length <= (input.passesWithMore ?? 0),
      }
    },

    async describeStorage() {
      return []
    },
  }

  return { maintenance, passes }
}

/** Versions projections applied, which a test can change between two passes. */
function appliedSources(versionIds: string[] = []) {
  const sources = {
    versionIds,
    async listActive(): Promise<readonly ActiveOntologySource[]> {
      return sources.versionIds.map((versionId) => ({
        source: { projectionId: "rooms" },
        projectionKind: "object",
        datasetVersion: { datasetId: "raw.rooms", versionId, createdAt: NOW.toISOString() },
        projectionRevision: "revision",
        ontologyRevision: "ontology",
        activatedAt: NOW.toISOString(),
      }))
    },
  }

  return sources
}

function runtime(input: {
  maintenance?: LakeMaintenance
  sources?: ReturnType<typeof appliedSources>
  options?: LakeMaintenanceOptions
  datasetCount?: number
}) {
  return createLakeRetentionRuntime({
    projectId: "project",
    options: input.options,
    lakeStorage: { maintenance: input.maintenance },
    sources: input.sources ?? appliedSources(),
    datasetCount: input.datasetCount ?? 1,
  })
}

/** Lets the pass loop reach its next pause or return, without waiting on real time. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

/** Runs a promise that pauses between passes, advancing fake time until it settles. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  const result = promise.finally(() => {
    settled = true
  })

  for (let turn = 0; turn < 100 && !settled; turn += 1) {
    await settle()
    jest.advanceTimersByTime(1_000)
  }

  return result
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(NOW)
})

afterEach(() => {
  jest.useRealTimers()
})

describe("lake maintenance settings", () => {
  test("default to hourly cleanup that keeps replaced versions and files for 7 days", () => {
    const settings = resolveLakeMaintenanceSettings(undefined)

    expect(settings).toEqual({
      enabled: true,
      keepVersionsFor: "7d",
      keepVersionsForMs: 7 * 24 * HOUR,
      deleteFilesAfter: "7d",
      deleteFilesAfterMs: 7 * 24 * HOUR,
      cleanupEvery: "1h",
      cleanupEveryMs: HOUR,
    })
    expect(lakeRetentionSchedule(settings)).toEqual({
      kind: "schedule",
      id: "sixb:lake-retention",
      trigger: { type: "cron", expression: "0 * * * *" },
    })
  })

  test("run every interval that divides an hour or a day, or every day or week", () => {
    const cron = (cleanupEvery: string) =>
      lakeRetentionSchedule(resolveLakeMaintenanceSettings({ cleanupEvery })).trigger.expression

    expect(cron("1m")).toBe("* * * * *")
    expect(cron("15m")).toBe("*/15 * * * *")
    expect(cron("60m")).toBe("0 * * * *")
    expect(cron("6h")).toBe("0 */6 * * *")
    expect(cron("24h")).toBe("0 0 * * *")
    expect(cron("1d")).toBe("0 0 * * *")
    expect(cron("1w")).toBe("0 0 * * 1")
  })

  test("refuse an interval cron cannot keep", () => {
    for (const cleanupEvery of ["90m", "45m", "5h", "2d"]) {
      expect(() => resolveLakeMaintenanceSettings({ cleanupEvery })).toThrow(
        `lakeMaintenance.cleanupEvery must divide an hour or a day, such as 15m, 1h, 6h or 1d; received "${cleanupEvery}".`
      )
    }
  })

  test("refuse a value that is not a duration, and versions kept for less than an hour", () => {
    expect(() => resolveLakeMaintenanceSettings({ deleteFilesAfter: "7 days" })).toThrow(
      'lakeMaintenance.deleteFilesAfter must be a duration such as 30m, 12h or 7d; received "7 days".'
    )
    expect(() => resolveLakeMaintenanceSettings({ cleanupEvery: "0m" })).toThrow(
      "lakeMaintenance.cleanupEvery must be a duration"
    )
    expect(() => resolveLakeMaintenanceSettings({ keepVersionsFor: "30m" })).toThrow(
      'lakeMaintenance.keepVersionsFor must be at least 1h; received "30m".'
    )
  })

  // The provider refuses it on every pass: a file a write in another process put in the data path
  // before committing would be deleted as an orphan. Reproduce: read `deleteFilesAfter` with
  // `durationOption` instead of `retentionOption` in maintenance/lake-retention.ts.
  test("refuse files deleted less than an hour after nothing reads them", () => {
    expect(() => resolveLakeMaintenanceSettings({ deleteFilesAfter: "30m" })).toThrow(
      'lakeMaintenance.deleteFilesAfter must be at least 1h; received "30m".'
    )
    expect(resolveLakeMaintenanceSettings({ deleteFilesAfter: "1h" }).deleteFilesAfterMs).toBe(HOUR)
  })

  test("schedule retention only when enabled, with a provider that maintains, and datasets", () => {
    const { maintenance } = fakeMaintenance()

    expect(runtime({ maintenance }).scheduled).toBe(true)
    expect(runtime({ maintenance, options: { enabled: false } }).scheduled).toBe(false)
    expect(runtime({ maintenance, datasetCount: 0 }).scheduled).toBe(false)
    expect(runtime({}).scheduled).toBe(false)
  })

  test("refuse to enable retention explicitly on a provider without maintenance", () => {
    expect(() => runtime({ options: { enabled: true } })).toThrow(
      "lakeMaintenance.enabled is true, but the lake storage provider has no maintenance."
    )
  })
})

describe("lake retention passes", () => {
  // Reproduce: read `protect` once before the loop in maintenance/lake-retention.ts.
  test("run while a pass reports more, protecting what is applied at each pass", async () => {
    const { maintenance, passes } = fakeMaintenance({ passesWithMore: 2 })
    const sources = appliedSources(["ducklake:1"])
    const retention = runtime({ maintenance, sources })

    const running = retention.apply({ keepVersionsForMs: HOUR, deleteFilesAfterMs: HOUR })
    await settle()
    sources.versionIds = ["ducklake:2"]
    const report = await drive(running)

    expect(passes.map((pass) => pass.protect)).toEqual([
      [{ datasetId: "raw.rooms", versionId: "ducklake:1" }],
      [{ datasetId: "raw.rooms", versionId: "ducklake:2" }],
      [{ datasetId: "raw.rooms", versionId: "ducklake:2" }],
    ])
    expect(report).toMatchObject({
      expiredVersions: 6,
      deletedFiles: 9,
      orphanedFiles: 3,
      hasMore: false,
    })
  })

  // Reproduce: remove the pause between passes in maintenance/lake-retention.ts.
  test("pause between two passes", async () => {
    const { maintenance, passes } = fakeMaintenance({ passesWithMore: 1 })
    const running = runtime({ maintenance }).apply({
      keepVersionsForMs: HOUR,
      deleteFilesAfterMs: HOUR,
    })

    await settle()
    expect(passes).toHaveLength(1)

    jest.advanceTimersByTime(999)
    await settle()
    expect(passes).toHaveLength(1)

    jest.advanceTimersByTime(1)
    await running
    expect(passes).toHaveLength(2)
  })

  // Reproduce: drop `async` from `apply` in maintenance/lake-retention.ts; the call then throws.
  test("reject, never throw, without a provider that maintains", async () => {
    let pending: Promise<unknown> | undefined
    expect(() => {
      pending = runtime({}).apply({ keepVersionsForMs: HOUR, deleteFilesAfterMs: HOUR })
    }).not.toThrow()

    const error = await pending?.catch((caught) => caught)
    expect(String(error)).toContain("The lake storage provider has no maintenance.")
  })

  test("run one pass on a dry run", async () => {
    const { maintenance, passes } = fakeMaintenance({ passesWithMore: 5 })

    const report = await runtime({ maintenance }).apply({
      keepVersionsForMs: HOUR,
      deleteFilesAfterMs: HOUR,
      dryRun: true,
    })

    expect(passes).toHaveLength(1)
    expect(passes[0]?.dryRun).toBe(true)
    expect(report.hasMore).toBe(true)
  })

  test("stop between passes when aborted", async () => {
    const { maintenance, passes } = fakeMaintenance({ passesWithMore: 5 })
    const controller = new AbortController()
    const running = runtime({ maintenance }).apply({
      keepVersionsForMs: HOUR,
      deleteFilesAfterMs: HOUR,
      signal: controller.signal,
    })

    await settle()
    controller.abort()

    const error = await running.catch((caught) => caught)
    expect((error as Error).name).toBe("AbortError")
    expect(passes).toHaveLength(1)
  })
})

describe("one occurrence of the retention schedule", () => {
  // Reproduce: drop `budgetMs` from runOccurrence in maintenance/lake-retention.ts.
  test("starts no pass once half its interval has passed", async () => {
    const { maintenance, passes } = fakeMaintenance({ passesWithMore: 5, passMs: 4 * MINUTE })
    const retention = runtime({ maintenance, options: { cleanupEvery: "10m" } })

    const report = await drive(
      retention.runOccurrence(NOW.toISOString(), new AbortController().signal)
    )

    expect(passes).toHaveLength(2)
    expect(report?.hasMore).toBe(true)
  })

  // Reproduce: remove the 10-minute cap from runOccurrence in maintenance/lake-retention.ts.
  test("holds a worker for 10 minutes at most, whatever its interval", async () => {
    const { maintenance, passes } = fakeMaintenance({ passesWithMore: 5, passMs: 4 * MINUTE })
    const retention = runtime({ maintenance, options: { cleanupEvery: "6h" } })

    await drive(retention.runOccurrence(NOW.toISOString(), new AbortController().signal))

    expect(passes).toHaveLength(3)
  })

  // Reproduce: remove the stale check from runOccurrence in maintenance/lake-retention.ts.
  test("does nothing for an occurrence older than its interval, which a later one covers", async () => {
    const { maintenance, passes } = fakeMaintenance()
    const retention = runtime({ maintenance })
    const signal = new AbortController().signal

    jest.setSystemTime(NOW.getTime() + HOUR + 1)
    expect(await retention.runOccurrence(NOW.toISOString(), signal)).toBeNull()
    expect(passes).toHaveLength(0)

    jest.setSystemTime(NOW.getTime() + HOUR)
    expect(await retention.runOccurrence(NOW.toISOString(), signal)).not.toBeNull()
    expect(passes).toHaveLength(1)
  })

  test("uses the configured retention", async () => {
    const { maintenance, passes } = fakeMaintenance()
    const retention = runtime({
      maintenance,
      options: { keepVersionsFor: "2d", deleteFilesAfter: "12h" },
    })

    await retention.runOccurrence(NOW.toISOString(), new AbortController().signal)

    expect(passes[0]).toMatchObject({
      keepVersionsForMs: 48 * HOUR,
      deleteFilesAfterMs: 12 * HOUR,
      dryRun: false,
    })
  })
})
