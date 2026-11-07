import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// A run whose job is gone comes back through the maintenance loop, in `sixb dev` as a project
// created from the template has it: persistent storage, and a queue that dies with its process.
// Nothing else publishes in the process that recovers them, so the `runs` pass is all there is.
//
// To see what this proves, drop `runs` from `startOrchestratorRuntime`: each run stays as it was
// until `RECOVERY_BOUND_MS`.

const CLI = resolve(import.meta.dir, "..", "src", "index.tsx")
const CONFIG = join(import.meta.dir, "fixtures/run-recovery/sixb.config.ts")
const PROCESS = join(import.meta.dir, "fixtures/run-recovery/process.ts")

const PROCESS_BUDGET_MS = 60_000
const RECOVERY_BOUND_MS = 45_000
const TEST_BOUND_MS = RECOVERY_BOUND_MS + 30_000
const SIGKILL_EXIT_CODE = 137

const stateDirs: string[] = []

afterEach(async () => {
  for (const dir of stateDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function runProcess(stateDir: string, primitive: string, phase: string): Promise<number> {
  const proc = Bun.spawn(["bun", PROCESS, stateDir, primitive, phase], {
    cwd: import.meta.dir,
    stdout: "ignore",
    stderr: "ignore",
  })
  const killTimer = setTimeout(() => proc.kill(), PROCESS_BUDGET_MS)

  try {
    return await proc.exited
  } finally {
    clearTimeout(killTimer)
  }
}

/** A lease and a queue's grace only pass with time. What the time is is not what this is about. */
function ageRuns(stateDir: string): void {
  const database = new Database(join(stateDir, "storage", "storage.sqlite"))
  const past = new Date(0).toISOString()

  database.run("UPDATE sync_runs SET execution_queue_lease_expires_at = ?", [past])
  database.run("UPDATE pipeline_runs SET queued_at = ?", [past])
  database.close()
}

function readRun(stateDir: string, table: string) {
  const database = new Database(join(stateDir, "storage", "storage.sqlite"), { readonly: true })

  try {
    return database.query(`SELECT status, attempt FROM ${table} WHERE id = 'run-1'`).get() as {
      readonly status: string
      readonly attempt: number
    }
  } finally {
    database.close()
  }
}

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const { port } = server
  server.stop(true)

  return port as number
}

async function untilEnded(stateDir: string, table: string) {
  const deadline = Date.now() + RECOVERY_BOUND_MS

  for (;;) {
    const run = readRun(stateDir, table)
    if (!["queued", "running"].includes(run.status) || Date.now() > deadline) return run

    await Bun.sleep(100)
  }
}

async function runDevUntilEnded(stateDir: string, table: string) {
  let output = ""
  const dev = Bun.spawn(["bun", CLI, "dev", "--entry", CONFIG, "--port", String(freePort())], {
    cwd: import.meta.dir,
    env: { ...process.env, SIXB_E2E_DIR: stateDir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const logs = Promise.all(
    [dev.stdout, dev.stderr].map(async (stream) => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk)
    })
  )
  const killTimer = setTimeout(() => dev.kill("SIGKILL"), RECOVERY_BOUND_MS + 15_000)

  try {
    return { run: await untilEnded(stateDir, table), output: () => output }
  } finally {
    dev.kill("SIGTERM")
    await dev.exited
    clearTimeout(killTimer)
    await logs
  }
}

async function createStateDir(): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), "sixb-run-recovery-dev-"))
  stateDirs.push(stateDir)

  return stateDir
}

test(
  "`sixb dev` resumes a run whose worker was killed with its queue",
  async () => {
    const stateDir = await createStateDir()

    expect(await runProcess(stateDir, "sync", "mid-read")).toBe(SIGKILL_EXIT_CODE)
    ageRuns(stateDir)
    expect(readRun(stateDir, "sync_runs").status).toBe("running")

    const { run, output } = await runDevUntilEnded(stateDir, "sync_runs")

    expect(run, output()).toEqual({ status: "succeeded", attempt: 2 })
  },
  TEST_BOUND_MS
)

test(
  "`sixb dev` starts a run whose job died with its queue",
  async () => {
    const stateDir = await createStateDir()

    expect(await runProcess(stateDir, "pipeline", "queue-only")).toBe(0)
    ageRuns(stateDir)
    expect(readRun(stateDir, "pipeline_runs").status).toBe("queued")

    const { run, output } = await runDevUntilEnded(stateDir, "pipeline_runs")

    expect(run, output()).toEqual({ status: "succeeded", attempt: 1 })
  },
  TEST_BOUND_MS
)
