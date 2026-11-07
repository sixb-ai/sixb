import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import type {
  LakeMaintenance,
  LakeRetentionOptions,
  LakeRetentionReport,
} from "../src/lake-storage"
import {
  createLakeRetentionRuntime,
  type LakeMaintenanceOptions,
  resolveLakeMaintenanceSettings,
} from "../src/maintenance/lake-retention"
import { InMemoryLakeRetentionRunStorage } from "../src/storage/lake-retention-runs"
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
  lakeRetentionRuns?: InMemoryLakeRetentionRunStorage
}) {
  return createLakeRetentionRuntime({
    projectId: "project",
    options: input.options,
    lakeStorage: { maintenance: input.maintenance },
    storage: { lakeRetentionRuns: input.lakeRetentionRuns },
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
  jest.restoreAllMocks()
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
  })

  test("take any duration as the interval", () => {
    expect(resolveLakeMaintenanceSettings({ cleanupEvery: "90m" }).cleanupEveryMs).toBe(90 * MINUTE)
    expect(resolveLakeMaintenanceSettings({ cleanupEvery: "5h" }).cleanupEveryMs).toBe(5 * HOUR)
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

  test("run on their own only when enabled, with a provider that maintains, and datasets", () => {
    const { maintenance } = fakeMaintenance()

    expect(runtime({ maintenance }).automatic).toBe(true)
    expect(runtime({ maintenance, options: { enabled: false } }).automatic).toBe(false)
    expect(runtime({ maintenance, datasetCount: 0 }).automatic).toBe(false)
    expect(runtime({}).automatic).toBe(false)
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

describe("a requested retention run", () => {
  const intervalStart = NOW.toISOString()
  const signal = new AbortController().signal

  // Reproduce: drop `budgetMs` from runRequested in maintenance/lake-retention.ts.
  test("starts no pass once half its interval has passed", async () => {
    const { maintenance, passes } = fakeMaintenance({ passesWithMore: 5, passMs: 4 * MINUTE })
    const retention = runtime({ maintenance, options: { cleanupEvery: "10m" } })

    const report = await drive(retention.runRequested(intervalStart, signal))

    expect(passes).toHaveLength(2)
    expect(report?.hasMore).toBe(true)
  })

  // Reproduce: remove the 10-minute cap from runRequested in maintenance/lake-retention.ts.
  test("holds a worker for 10 minutes at most, whatever its interval", async () => {
    const { maintenance, passes } = fakeMaintenance({ passesWithMore: 5, passMs: 4 * MINUTE })
    const retention = runtime({ maintenance, options: { cleanupEvery: "6h" } })

    await drive(retention.runRequested(intervalStart, signal))

    expect(passes).toHaveLength(3)
  })

  // Reproduce: remove the check on the interval from runRequested in maintenance/lake-retention.ts.
  test("does nothing once its interval is over, which the next request covers", async () => {
    const { maintenance, passes } = fakeMaintenance()
    const retention = runtime({ maintenance })

    jest.setSystemTime(NOW.getTime() + HOUR)
    expect(await retention.runRequested(intervalStart, signal)).toBeNull()
    expect(passes).toHaveLength(0)

    jest.setSystemTime(NOW.getTime() + HOUR - 1)
    expect(await retention.runRequested(intervalStart, signal)).not.toBeNull()
    expect(passes).toHaveLength(1)
  })

  test("uses the configured retention", async () => {
    const { maintenance, passes } = fakeMaintenance()
    const retention = runtime({
      maintenance,
      options: { keepVersionsFor: "2d", deleteFilesAfter: "12h" },
    })

    await retention.runRequested(intervalStart, signal)

    expect(passes[0]).toMatchObject({
      keepVersionsForMs: 48 * HOUR,
      deleteFilesAfterMs: 12 * HOUR,
      dryRun: false,
    })
  })

  // Reproduce: drop `finish(false)` from runRequested in maintenance/lake-retention.ts.
  test("records that it ran", async () => {
    const { maintenance } = fakeMaintenance({ passMs: MINUTE })
    const lakeRetentionRuns = new InMemoryLakeRetentionRunStorage()

    await runtime({ maintenance, lakeRetentionRuns }).runRequested(intervalStart, signal)

    expect(await lakeRetentionRuns.getLast({ projectId: "project" })).toEqual({
      projectId: "project",
      startedAt: NOW,
      finishedAt: new Date(NOW.getTime() + MINUTE),
      failed: false,
    })
  })

  // A first run can last ten minutes, and it is the proof that a worker exists. Reproduce: drop the
  // first `recordRun` from runRequested in maintenance/lake-retention.ts.
  test("records that it started before its first pass ends", async () => {
    const { maintenance, passes } = fakeMaintenance({ passesWithMore: 1 })
    const lakeRetentionRuns = new InMemoryLakeRetentionRunStorage()

    const running = runtime({ maintenance, lakeRetentionRuns }).runRequested(intervalStart, signal)
    await settle()

    expect(passes).toHaveLength(1)
    expect(await lakeRetentionRuns.getLast({ projectId: "project" })).toMatchObject({
      startedAt: NOW,
      finishedAt: null,
    })

    await drive(running)
  })

  // Reproduce: drop `!automatic` from runRequested in maintenance/lake-retention.ts. A request
  // queued before the project turned retention off would then run.
  test("does nothing once the project turned retention off", async () => {
    const { maintenance, passes } = fakeMaintenance()
    const retention = runtime({ maintenance, options: { enabled: false } })

    expect(await retention.runRequested(intervalStart, signal)).toBeNull()
    expect(passes).toHaveLength(0)
  })

  // Reproduce: drop `signal` from the applyRetention call in maintenance/lake-retention.ts.
  test("hands its signal to each pass, so a provider can stop waiting", async () => {
    const { maintenance, passes } = fakeMaintenance()

    await runtime({ maintenance }).runRequested(intervalStart, signal)

    expect(passes[0]?.signal).toBe(signal)
  })

  // Reproduce: drop the catch from runRequested in maintenance/lake-retention.ts.
  test("records that it failed, and still fails", async () => {
    const { maintenance } = fakeMaintenance()
    maintenance.applyRetention = async () => {
      throw new Error("the catalog is unreachable")
    }
    const lakeRetentionRuns = new InMemoryLakeRetentionRunStorage()
    const retention = runtime({ maintenance, lakeRetentionRuns })

    const error = await retention.runRequested(intervalStart, signal).catch((caught) => caught)

    expect(String(error)).toContain("the catalog is unreachable")
    expect(await lakeRetentionRuns.getLast({ projectId: "project" })).toMatchObject({
      failed: true,
    })
  })

  // Reproduce: pass `true` to `finish` in the catch of runRequested in maintenance/lake-retention.ts.
  test("records no failure when shutdown stops it, since the job returns to the queue", async () => {
    const { maintenance } = fakeMaintenance({ passesWithMore: 5 })
    const lakeRetentionRuns = new InMemoryLakeRetentionRunStorage()
    const controller = new AbortController()
    const running = runtime({ maintenance, lakeRetentionRuns }).runRequested(
      intervalStart,
      controller.signal
    )

    await settle()
    controller.abort()
    await running.catch((caught) => caught)

    expect(await lakeRetentionRuns.getLast({ projectId: "project" })).toMatchObject({
      finishedAt: NOW,
      failed: false,
    })
  })

  // Reproduce: drop the `.catch` from `recordRun` in maintenance/lake-retention.ts.
  test("keeps its outcome when recording it fails", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    const { maintenance } = fakeMaintenance()
    const lakeRetentionRuns = new InMemoryLakeRetentionRunStorage()
    lakeRetentionRuns.record = async () => {
      throw new Error("storage is unreachable")
    }

    const report = await runtime({ maintenance, lakeRetentionRuns }).runRequested(
      intervalStart,
      signal
    )

    expect(report?.expiredVersions).toBe(2)
    expect(String(error.mock.calls[0])).toContain("Could not record a lake retention run")
  })
})
