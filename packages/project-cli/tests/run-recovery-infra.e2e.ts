import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Crash recovery on the infrastructure production runs on: BullMQ on Redis, PostgreSQL storage, and
// DuckLake with a PostgreSQL catalog. A worker is killed with SIGKILL right after its lake commit.
// Its queue lease then runs out for real, and BullMQ redelivers the job to the next process, with
// nothing in this test helping it along.
//
// The services are throwaway containers of this test's own Compose project.
//
// To see what a guard proves, remove it and run this file:
// - the producer lookup in `runSyncJob` or `runStep`: the commit lands twice.
// - the hold on a run with no lease in `planRunClaim`: the rolling deploy case runs it beside the
//   worker that holds it.

const COMPOSE_FILE = join(import.meta.dir, "fixtures/run-recovery/docker-compose.yml")
const COMPOSE_PROJECT = `sixb-run-recovery-${process.pid}`
const PROCESS = join(import.meta.dir, "fixtures/run-recovery/infra-process.ts")

const CONTAINERS_BUDGET_MS = 120_000
const PROCESS_BUDGET_MS = 60_000
const SIGKILL_EXIT_CODE = 137

const compose = ["docker", "compose", "-p", COMPOSE_PROJECT, "-f", COMPOSE_FILE]

const services = { postgresPort: 0, redisPort: 0 }
const stateDirs: string[] = []
let databases = 0

async function runBounded(command: string[], env: Record<string, string>, budgetMs: number) {
  const proc = Bun.spawn(command, {
    cwd: import.meta.dir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()

  const killTimer = setTimeout(() => proc.kill(), budgetMs)
  try {
    const exitCode = await proc.exited
    return { exitCode, stdout: await stdout, stderr: await stderr }
  } finally {
    clearTimeout(killTimer)
  }
}

async function dockerCompose(args: string[]) {
  const result = await runBounded([...compose, ...args], {}, CONTAINERS_BUDGET_MS)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function publishedPort(service: string, port: number): Promise<number> {
  const published = await dockerCompose(["port", service, String(port)])
  return Number(published.split(":").at(-1))
}

beforeAll(async () => {
  await dockerCompose(["up", "-d", "--wait"])
  services.postgresPort = await publishedPort("postgres", 5432)
  services.redisPort = await publishedPort("redis", 6379)
}, CONTAINERS_BUDGET_MS)

afterAll(async () => {
  await dockerCompose(["down", "-v", "--remove-orphans"])
}, CONTAINERS_BUDGET_MS)

afterEach(async () => {
  for (const dir of stateDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** One project's worth of state: its own database, Redis key space and lake files. */
async function createEnvironment(): Promise<Record<string, string>> {
  databases += 1
  const database = `recovery_${databases}`

  await dockerCompose(["exec", "-T", "postgres", "createdb", "-U", "postgres", database])
  await dockerCompose(["exec", "-T", "redis", "redis-cli", "flushall"])

  const stateDir = await mkdtemp(join(tmpdir(), "sixb-run-recovery-infra-"))
  stateDirs.push(stateDir)

  return {
    RECOVERY_STATE_DIR: stateDir,
    RECOVERY_POSTGRES_URL: `postgresql://postgres:test@127.0.0.1:${services.postgresPort}/${database}`,
    RECOVERY_POSTGRES_PORT: String(services.postgresPort),
    RECOVERY_POSTGRES_DATABASE: database,
    RECOVERY_REDIS_URL: `redis://127.0.0.1:${services.redisPort}`,
  }
}

function runProcess(env: Record<string, string>, primitive: string, phase: string) {
  return runBounded(["bun", PROCESS, primitive, phase], env, PROCESS_BUDGET_MS)
}

function parseReport(stdout: string) {
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")
}

async function crashThenResume(primitive: "sync" | "pipeline") {
  const env = await createEnvironment()

  const crashed = await runProcess(env, primitive, "crash")
  expect(crashed.exitCode, crashed.stderr).toBe(SIGKILL_EXIT_CODE)

  const resumed = await runProcess(env, primitive, "resume")
  expect(resumed.exitCode, resumed.stderr).toBe(0)

  return parseReport(resumed.stdout)
}

describe("a worker killed on production infrastructure", () => {
  test("a sync's commit is recorded once its lease really ran out", async () => {
    const after = await crashThenResume("sync")

    expect(after.run).toMatchObject({ status: "succeeded", attempt: 2 })
    expect(after.orders).toEqual([{ id: "after-start" }])
  }, 150_000)

  test("a pipeline's append is written once", async () => {
    const after = await crashThenResume("pipeline")

    expect(after.run).toMatchObject({ status: "succeeded", attempt: 2 })
    expect(after.orders).toHaveLength(2)
  }, 150_000)
})

describe("a rolling deploy", () => {
  test.each([
    "sync",
    "pipeline",
  ])("a new worker leaves an old worker's %s run alone", async (primitive) => {
    const env = await createEnvironment()

    const result = await runProcess(env, primitive, "old-worker")
    expect(result.exitCode, result.stderr).toBe(0)

    const { whileHeld, finished } = parseReport(result.stdout)
    expect(whileHeld).toMatchObject({ status: "running", attempt: 1 })
    expect(whileHeld.execution).toBeUndefined()
    expect(finished).toMatchObject({ status: "succeeded" })
  }, 150_000)

  test.each([
    "sync",
    "pipeline",
  ])("an old worker's %s run that outlived any deploy is settled", async (primitive) => {
    const env = await createEnvironment()

    const result = await runProcess(env, primitive, "orphan")
    expect(result.exitCode, result.stderr).toBe(0)

    const { result: pass, run } = parseReport(result.stdout)
    expect(pass).toEqual({ republished: 0, settled: 1 })
    expect(run).toMatchObject({ status: "cancelled", error: { code: "runtime.cancelled" } })
  }, 150_000)
})
