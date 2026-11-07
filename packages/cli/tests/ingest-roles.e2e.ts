import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { LocalLakeStorage } from "@sixb/lake-local"
import { $ } from "bun"
import { startRoleUntilReadyThenStop } from "./shared/cli-process"

// Real roles in real processes, sharing a real queue: what cannot be shown in one process is that
// a webhook reaches the lake with no orchestrator running. Its own Redis, on a port Docker picks,
// so it runs beside the packages' suites.

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
const fixtureEntry = resolve(import.meta.dir, "fixtures", "ingest-roles", "sixb.config.ts")

const DATASET_ID = "raw.people"
const WEBHOOK_PATH = "/api/webhooks/crm/person"

const REDIS_TIMEOUT_MS = 60_000
const REACHES_LAKE_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 90_000

const redisContainer = `sixb-ingest-roles-${randomUUID()}`
let redisUrl = ""

const directories: string[] = []

beforeAll(async () => {
  await $`docker run -d --rm --name ${redisContainer} -p 127.0.0.1::6379 redis:7-alpine`.quiet()

  const published = await $`docker port ${redisContainer} 6379`.text()
  redisUrl = `redis://${published.trim().split("\n")[0]}`

  await untilRedisAnswers()
}, REDIS_TIMEOUT_MS)

afterAll(async () => {
  await $`docker rm -f ${redisContainer}`.quiet().nothrow()
})

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function untilRedisAnswers(): Promise<void> {
  const deadline = Date.now() + REDIS_TIMEOUT_MS / 2

  while (Date.now() < deadline) {
    const pong = await $`docker exec ${redisContainer} redis-cli ping`.quiet().nothrow().text()
    if (pong.trim() === "PONG") return

    await Bun.sleep(100)
  }

  throw new Error("Redis did not answer.")
}

async function project() {
  const directory = await mkdtemp(join(tmpdir(), "sixb-ingest-roles-"))
  directories.push(directory)

  return { directory, env: { SIXB_E2E_DIR: directory, SIXB_E2E_REDIS_URL: redisUrl } }
}

type Env = Readonly<Record<string, string>>

/** Runs `whileReady` with the role running, and stops it after. */
async function whileRunning(
  role: readonly string[],
  env: Env,
  whileReady: () => Promise<void>
): Promise<void> {
  const logPath = join(env.SIXB_E2E_DIR ?? "", `${role[0]}-${randomUUID()}.log`)

  const { ready } = await startRoleUntilReadyThenStop({
    cmd: ["bun", cliEntry, ...role, "--entry", fixtureEntry],
    cwd: repoRoot,
    env,
    logPath,
    timeoutMs: 30_000,
    whileReady,
  })

  expect(ready).toBe(true)
}

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const { port } = server
  server.stop(true)

  if (port === undefined) throw new Error("Could not reserve a free TCP port.")
  return port
}

/** The API role, and how to send it a webhook. */
async function whileServing(
  env: Env,
  whileReady: (send: (id: string) => Promise<Response>) => Promise<void>
): Promise<void> {
  const [appPort, apiPort] = [freePort(), freePort()]
  const role = [
    "api",
    "--port",
    String(appPort),
    "--host",
    "127.0.0.1",
    "--api-host",
    "127.0.0.1",
    "--api-port",
    String(apiPort),
    "--api-public-origin",
    `http://localhost:${apiPort}`,
    "--app-public-origin",
    `http://localhost:${appPort}`,
  ]

  const send = (id: string) =>
    fetch(`http://127.0.0.1:${apiPort}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-delivery": `delivery-${id}` },
      body: JSON.stringify({ id, name: `Person ${id}` }),
    })

  await whileRunning(role, env, () => whileReady(send))
}

/** A reader of its own each time: it sees what the other processes committed. */
function versions(directory: string) {
  return new LocalLakeStorage({ path: join(directory, "lake") }).listVersions(DATASET_ID)
}

/** Waits for the dataset to hold `rows` rows, and answers with the versions that wrote them. */
async function untilInLake(directory: string, rows: number) {
  const deadline = Date.now() + REACHES_LAKE_TIMEOUT_MS

  while (Date.now() < deadline) {
    const found = await versions(directory).catch(() => [])
    if (found.at(0)?.rowCount === rows) return found

    await Bun.sleep(100)
  }

  throw new Error(`${rows} row(s) did not reach the lake within ${REACHES_LAKE_TIMEOUT_MS} ms.`)
}

describe("ingestion across roles", () => {
  // Reproduce: drop the `tryEnqueueIngestFlush` call from `ingest` (datasets/execution.ts).
  test(
    "a webhook reaches the lake with no orchestrator running",
    async () => {
      const { directory, env } = await project()

      await whileServing(env, async (send) => {
        await whileRunning(["worker", "lake"], env, async () => {
          expect((await send("1")).status).toBe(200)

          expect((await untilInLake(directory, 1)).at(0)?.producer?.kind).toBe("ingest")
        })
      })
    },
    TEST_TIMEOUT_MS
  )

  // Reproduce: set DATASET_INGEST_MAX_CHANGES to 1 in ingest-flush.ts; the burst is then written
  // as one version per delivery.
  test(
    "a burst that waited for a worker is written as one version",
    async () => {
      const { directory, env } = await project()

      await whileServing(env, async (send) => {
        const burst = Array.from({ length: 20 }, (_, index) => send(`${index}`))

        for (const response of await Promise.all(burst)) expect(response.status).toBe(200)

        await whileRunning(["worker", "lake"], env, async () => {
          expect(await untilInLake(directory, 20)).toHaveLength(1)
        })
      })
    },
    TEST_TIMEOUT_MS
  )

  // Reproduce: leave `ingest` out of the createReconciliationPasses call in lib/runtime.ts.
  test(
    "a flush the queue refused is queued by the orchestrator's pass",
    async () => {
      const { directory, env } = await project()
      const refusing = { ...env, SIXB_E2E_REFUSE_ENQUEUE: "1" }

      await whileServing(refusing, async (send) => {
        expect((await send("1")).status).toBe(200)

        await whileRunning(["worker", "lake"], env, async () => {
          await whileRunning(["orchestrator"], env, async () => {
            expect(await untilInLake(directory, 1)).toHaveLength(1)
          })
        })
      })
    },
    TEST_TIMEOUT_MS
  )
})
