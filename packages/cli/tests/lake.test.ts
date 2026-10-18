import { afterEach, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { runLakeCheck } from "../src/commands/lake-check"
import { runLakeCleanup } from "../src/commands/lake-cleanup"
import { lakeFixture } from "./fixtures/lake-project/sixb.config"
import { MISDECLARED_MARKINGS_MESSAGE } from "./fixtures/shared/createMisdeclaredMarkingsSixb"
import { FAST_CLI_TIMEOUT_MS, runCliToCompletion } from "./shared/cli-process"
import { runInProcess } from "./shared/in-process"

const entry = resolve(import.meta.dir, "fixtures", "lake-project", "sixb.config.ts")
const closed = { type: "lake-storage:close" }

afterEach(() => {
  Object.assign(lakeFixture, { drift: false, maintenance: true, appliedVersion: undefined })
  lakeFixture.events = []
})

/** The report as one line: Ink pads each label to a column. */
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
      "Snapshots 2 Kept snapshots 5 Old files 3 Orphaned files 4"
    )
    expect(lakeFixture.events).toEqual([
      {
        type: "lake:maintenance",
        dryRun: true,
        expireOlderThan: "7 days",
        deleteOlderThan: "7 days",
        protect: [],
      },
      closed,
    ])
  })

  test("passes the retention flags through, and defaults delete retention to expire retention", async () => {
    const flags = await runInProcess(() =>
      runLakeCleanup({ entry, expireOlderThan: "1 hour", deleteOlderThan: "30 minutes" })
    )
    const expireOnly = await runInProcess(() =>
      runLakeCleanup({ entry, dryRun: true, expireOlderThan: "2 days" })
    )

    expect(flags.output).toContain("Lake cleanup complete")
    expect(flat(flags.output)).toContain("Expire older than 1 hour Delete older than 30 minutes")
    expect(expireOnly.error).toBeUndefined()
    expect(lakeFixture.events).toEqual([
      {
        type: "lake:maintenance",
        dryRun: false,
        expireOlderThan: "1 hour",
        deleteOlderThan: "30 minutes",
        protect: [],
      },
      closed,
      {
        type: "lake:maintenance",
        dryRun: true,
        expireOlderThan: "2 days",
        deleteOlderThan: "2 days",
        protect: [],
      },
      closed,
    ])
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
        "--expire-older-than",
        "2 days",
      ],
      cwd: resolve(import.meta.dir, "..", "..", ".."),
      timeoutMs: FAST_CLI_TIMEOUT_MS,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Lake cleanup dry run complete")
    expect(flat(result.stdout)).toContain(
      "Dry run true Expire older than 2 days Delete older than 2 days"
    )
    expect(result.stderr).toBe("")
  })

  // Reproduce: drop `protect` from the runMaintenance call in commands/lake-cleanup.tsx.
  test("keeps the dataset versions projections applied", async () => {
    lakeFixture.appliedVersion = "ducklake:42"

    const result = await runInProcess(() => runLakeCleanup({ entry, dryRun: true }))

    expect(result.error).toBeUndefined()
    expect(lakeFixture.events[0]).toMatchObject({
      protect: [{ datasetId: "raw.things", versionId: "ducklake:42" }],
    })
  })

  // Reproduce: fall back to no protected versions when listActive fails in commands/lake-cleanup.tsx.
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
      "Configured lake storage does not support maintenance cleanup"
    )
    expect(lakeFixture.events).toEqual([closed])
  })
})
