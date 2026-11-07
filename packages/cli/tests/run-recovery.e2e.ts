import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Runs that survive their process, end to end: a real worker on SQLite and DuckLake files, killed
// with SIGKILL at a chosen point. Nothing of that process runs afterwards, and its queue goes with
// it, so a new process finds the run only through what is durable.
//
// To see what each guard proves, remove it and run this file:
// - the producer lookup in `runSyncJob` or `runStep`: `after-commit` writes the rows twice.
// - `prepareCommit` in `runSyncJob`: `after-commit` re-reads the source in the next run.
// - the lookup in the catch of `runSyncJob` or `runStep`: `lost-reply` writes the rows twice.

const PROCESS = join(import.meta.dir, "fixtures/run-recovery/process.ts")
const PROCESS_BUDGET_MS = 60_000
const SIGKILL_EXIT_CODE = 137

const stateDirs: string[] = []

afterEach(async () => {
  for (const dir of stateDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-run-recovery-"))
  stateDirs.push(dir)
  return dir
}

async function runProcess(stateDir: string, primitive: string, phase: string) {
  const proc = Bun.spawn(["bun", PROCESS, stateDir, primitive, phase], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()

  const killTimer = setTimeout(() => proc.kill(), PROCESS_BUDGET_MS)
  try {
    const exitCode = await proc.exited
    return { exitCode, stdout: await stdout, stderr: await stderr }
  } finally {
    clearTimeout(killTimer)
  }
}

/** A lease only lapses with time. What the time would be is not what this test is about. */
function letLeaseRunOut(stateDir: string): void {
  const database = new Database(join(stateDir, "storage", "storage.sqlite"))
  const past = new Date(0).toISOString()

  database.run("UPDATE sync_runs SET execution_queue_lease_expires_at = ?", [past])
  database.run("UPDATE pipeline_runs SET execution_queue_lease_expires_at = ?", [past])
  database.close()
}

async function crashThenResume(primitive: "sync" | "pipeline", crashPoint: string) {
  const stateDir = await createStateDir()

  const crashed = await runProcess(stateDir, primitive, crashPoint)
  expect(crashed.exitCode, crashed.stderr).toBe(SIGKILL_EXIT_CODE)

  letLeaseRunOut(stateDir)

  const resumed = await runProcess(stateDir, primitive, "resume")
  expect(resumed.exitCode, resumed.stderr).toBe(0)

  return JSON.parse(resumed.stdout.trim().split("\n").at(-1) ?? "{}")
}

describe("a commit that landed and answered with an error", () => {
  async function runWithLostReply(primitive: "sync" | "pipeline") {
    const finished = await runProcess(await createStateDir(), primitive, "lost-reply")
    expect(finished.exitCode, finished.stderr).toBe(0)

    return JSON.parse(finished.stdout.trim().split("\n").at(-1) ?? "{}")
  }

  test("a sync records it, and the next run reads on from its checkpoint", async () => {
    const after = await runWithLostReply("sync")

    expect(after.run).toMatchObject({ status: "succeeded", attempt: 1 })
    expect(after.orders).toEqual([{ id: "after-start" }, { id: "after-read-once" }])
  }, 120_000)

  test("a pipeline records the step, and writes nothing twice", async () => {
    const after = await runWithLostReply("pipeline")

    expect(after.run).toMatchObject({ status: "succeeded", attempt: 1 })
    expect(after.orders).toHaveLength(2)
    expect(after.published).toHaveLength(2)
  }, 120_000)
})

describe("a run whose process was killed", () => {
  test("a sync killed mid-read leaves nothing in the lake, and reads again", async () => {
    const after = await crashThenResume("sync", "mid-read")

    expect(after.run).toMatchObject({ status: "succeeded", attempt: 2 })
    // The second row is the next run, which reads from the checkpoint of the first.
    expect(after.orders).toEqual([{ id: "after-start" }, { id: "after-read-once" }])
  }, 120_000)

  test("a sync killed right after its commit is recorded, with the checkpoint it paid for", async () => {
    const after = await crashThenResume("sync", "after-commit")

    expect(after.run).toMatchObject({ status: "succeeded", attempt: 2 })
    expect(after.orders).toEqual([{ id: "after-start" }, { id: "after-read-once" }])
  }, 120_000)

  test("a pipeline killed mid-step redoes that step only", async () => {
    const after = await crashThenResume("pipeline", "mid-read")

    expect(after.run).toMatchObject({ status: "succeeded", attempt: 2 })
    expect(after.orders).toHaveLength(2)
    expect(after.published).toHaveLength(2)
  }, 120_000)

  test.each([
    "after-commit",
    "after-sql-commit",
  ])("a pipeline killed %s writes nothing twice", async (crashPoint) => {
    const after = await crashThenResume("pipeline", crashPoint)

    expect(after.run).toMatchObject({ status: "succeeded", attempt: 2 })
    expect(after.orders).toHaveLength(2)
    expect(after.published).toHaveLength(2)
    expect(after.steps.map((step: { status: string }) => step.status)).toEqual([
      "succeeded",
      "succeeded",
    ])
  }, 120_000)
})
