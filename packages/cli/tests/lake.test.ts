import { afterEach, describe, expect, jest, test } from "bun:test"
import { resolve } from "node:path"
import { runLakeCheck } from "../src/commands/lake-check"
import { runLakeCleanup } from "../src/commands/lake-cleanup"
import { lakeFixture } from "./fixtures/lake-project/sixb.config"
import { MISDECLARED_MARKINGS_MESSAGE } from "./fixtures/shared/createMisdeclaredMarkingsSixb"
import { FAST_CLI_TIMEOUT_MS, runCliToCompletion } from "./shared/cli-process"
import { runInProcess } from "./shared/in-process"

const entry = resolve(import.meta.dir, "fixtures", "lake-project", "sixb.config.ts")
const closed = { type: "lake-storage:close" }
const DAY_MS = 24 * 60 * 60_000

afterEach(() => {
  Object.assign(lakeFixture, {
    drift: false,
    maintenance: true,
    lakeMaintenance: undefined,
    unansweredRequest: false,
    retentionPassesWithMore: 0,
    appliedVersion: undefined,
  })
  lakeFixture.events = []
})

/** The report as one line: the screen pads each label to a column. */
function flat(output: string): string {
  return output.replace(/[\s│]+/g, " ")
}

describe("sixb lake check", () => {
  test("reports compatible definitions, then closes providers", async () => {
    const result = await runInProcess(() => runLakeCheck({ entry }))

    expect(result.error).toBeUndefined()
    expect(result.output).toContain("Lake definitions compatible")
    expect(result.output).toContain("cli-lake-project")
    expect(lakeFixture.events).toEqual([closed])
  })

  test("fails when lake definitions drift, and still closes providers", async () => {
    lakeFixture.drift = true

    const result = await runInProcess(() => runLakeCheck({ entry }))

    expect(String(result.error)).toContain("Lake dataset definition check failed")
    expect(lakeFixture.events).toEqual([closed])
  })

  // Reproduce: remove `checkRuntimePipelineMarkings` from commands/lake-check.tsx; this passes.
  test("fails when a SQL step gives a projected column undeclared markings", async () => {
    const misdeclared = resolve(
      import.meta.dir,
      "fixtures",
      "misdeclared-markings-project",
      "sixb.config.ts"
    )

    const result = await runInProcess(() => runLakeCheck({ entry: misdeclared }))

    expect(String(result.error)).toContain(MISDECLARED_MARKINGS_MESSAGE)
  })
})

describe("sixb lake cleanup", () => {
  test("runs a dry run with the default retention, prints the report, and closes providers", async () => {
    const result = await runInProcess(() => runLakeCleanup({ entry, dryRun: true }))

    expect(result.error).toBeUndefined()
    expect(result.output).toContain("Lake cleanup dry run complete")
    expect(result.output).toContain("cli-lake-project")
    expect(flat(result.output)).toContain(
      "Expired versions 2 Kept versions 5 Deleted files 3 Orphaned files 4"
    )
    expect(lakeFixture.events).toEqual([
      {
        type: "lake:retention",
        dryRun: true,
        keepVersionsForMs: 7 * DAY_MS,
        deleteFilesAfterMs: 7 * DAY_MS,
        protect: [],
      },
      closed,
    ])
  })

  test("passes the retention flags through as durations", async () => {
    const result = await runInProcess(() =>
      runLakeCleanup({ entry, keepVersionsFor: "2h", deleteFilesAfter: "1h" })
    )

    expect(result.output).toContain("Lake cleanup complete")
    expect(flat(result.output)).toContain("Keep versions for 2h Delete files after 1h")
    expect(lakeFixture.events[0]).toMatchObject({
      keepVersionsForMs: 2 * 60 * 60_000,
      deleteFilesAfterMs: 60 * 60_000,
    })
  })

  // Reproduce: default to "7d" in commands/lake-cleanup.ts. Cleanup then expires versions the project
  // asked to keep for a month, and the dry run measures something no run would do.
  test("keeps what the project's lakeMaintenance keeps when no flag says otherwise", async () => {
    lakeFixture.lakeMaintenance = { keepVersionsFor: "30d", deleteFilesAfter: "14d" }

    const result = await runInProcess(() => runLakeCleanup({ entry, dryRun: true }))

    expect(flat(result.output)).toContain("Keep versions for 30d Delete files after 14d")
    expect(lakeFixture.events[0]).toMatchObject({
      keepVersionsForMs: 30 * DAY_MS,
      deleteFilesAfterMs: 14 * DAY_MS,
    })
  })

  // Reproduce: read both durations from `settings` in commands/lake-cleanup.ts.
  test("lets a flag override one setting and keeps the other", async () => {
    lakeFixture.lakeMaintenance = { keepVersionsFor: "30d", deleteFilesAfter: "14d" }

    const result = await runInProcess(() =>
      runLakeCleanup({ entry, dryRun: true, keepVersionsFor: "2d" })
    )

    expect(flat(result.output)).toContain("Keep versions for 2d Delete files after 14d")
    expect(lakeFixture.events[0]).toMatchObject({
      keepVersionsForMs: 2 * DAY_MS,
      deleteFilesAfterMs: 14 * DAY_MS,
    })
  })

  // Reproduce: call `maintenance.applyRetention` once in commands/lake-cleanup.ts.
  test("cleans up until no pass reports more, and adds the passes up", async () => {
    lakeFixture.retentionPassesWithMore = 1
    jest.useFakeTimers()

    try {
      const running = runInProcess(() => runLakeCleanup({ entry }))
      // Passes pause a second between them; move the clock until the command is done.
      let done = false
      void running.finally(() => {
        done = true
      })
      for (let turn = 0; turn < 1_000 && !done; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        jest.advanceTimersByTime(100)
      }
      const result = await running

      expect(result.error).toBeUndefined()
      expect(lakeFixture.events.filter((event) => event.type === "lake:retention")).toHaveLength(2)
      expect(flat(result.output)).toContain(
        "Expired versions 4 Kept versions 5 Deleted files 6 Orphaned files 8"
      )
      expect(result.output).not.toContain("more is due")
    } finally {
      jest.useRealTimers()
    }
  })

  // Reproduce: print the dry run's counts as they are in ui/screens.ts lakeCleanupView. The
  // output then reads like the whole backlog.
  test("measures one pass on a dry run, and says when more remain", async () => {
    lakeFixture.retentionPassesWithMore = 1

    const result = await runInProcess(() => runLakeCleanup({ entry, dryRun: true }))

    expect(result.error).toBeUndefined()
    expect(lakeFixture.events.filter((event) => event.type === "lake:retention")).toHaveLength(1)
    expect(flat(result.output)).toContain(
      "Expired versions 2+ Kept versions 5 Deleted files 3+ Orphaned files 4+"
    )
    expect(result.output).toContain("one pass measured, more remain")
  })

  // Reproduce: parse the flags after loading the project in commands/lake-cleanup.ts. The project
  // then loads and closes before the flag fails.
  test("rejects a retention that is not a duration before loading the project", async () => {
    const result = await runInProcess(() => runLakeCleanup({ entry, keepVersionsFor: "7 days" }))

    expect(String(result.error)).toContain("Use --keep-versions-for like 30d, 12h, 4w, or 1y.")
    expect(lakeFixture.events).toEqual([])
  })

  // The flags as `sixb` hands them over. The fixture reports the dry run it was asked for.
  // Reproduce: pass `dryRun: false` to runLakeCleanup in src/index.tsx.
  test("reaches cleanup with the command line's dry run and retention", async () => {
    const result = await runCliToCompletion({
      cmd: [
        "bun",
        resolve(import.meta.dir, "..", "src", "index.tsx"),
        "lake",
        "cleanup",
        "--entry",
        entry,
        "--dry-run",
        "--keep-versions-for",
        "2d",
      ],
      cwd: resolve(import.meta.dir, "..", "..", ".."),
      timeoutMs: FAST_CLI_TIMEOUT_MS,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Lake cleanup dry run complete")
    expect(flat(result.stdout)).toContain("Keep versions for 2d Delete files after 7d")
    expect(result.stderr).toBe("")
  })

  // Reproduce: drop `protect` from the applyRetention call in commands/lake-cleanup.ts.
  test("keeps the dataset versions projections applied", async () => {
    lakeFixture.appliedVersion = "ducklake:42"

    const result = await runInProcess(() => runLakeCleanup({ entry, dryRun: true }))

    expect(result.error).toBeUndefined()
    expect(lakeFixture.events[0]).toMatchObject({
      protect: [{ datasetId: "raw.things", versionId: "ducklake:42" }],
    })
  })

  // Reproduce: fall back to no protected versions when listActive fails in commands/lake-cleanup.ts.
  test("does not clean the lake when the applied versions cannot be read", async () => {
    lakeFixture.appliedVersion = "unreadable"

    const result = await runInProcess(() => runLakeCleanup({ entry }))

    expect(String(result.error)).toContain("ontology storage is unreachable")
    expect(lakeFixture.events).toEqual([closed])
  })

  test("fails clearly when lake storage does not support cleanup", async () => {
    lakeFixture.maintenance = false

    const result = await runInProcess(() => runLakeCleanup({ entry, dryRun: true }))

    expect(String(result.error)).toContain(
      "Configured lake storage does not support retention cleanup"
    )
    expect(lakeFixture.events).toEqual([closed])
  })
})
