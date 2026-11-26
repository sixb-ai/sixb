/**
 * One process of `run-recovery-infra.e2e.ts`: real workers on PostgreSQL, Redis and DuckLake with a
 * PostgreSQL catalog. Nothing here is told about any other process: what it finds, it finds in
 * those services.
 *
 * bun infra-process.ts <sync|pipeline> <crash|resume|old-worker>
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  col,
  type DatasetRow,
  defineConnector,
  defineDataset,
  definePipeline,
  definePipelineStep,
  defineSync,
  InMemoryBlobStorage,
  InMemoryBroker,
  migrateStorage,
  SixbHost,
} from "@sixb/core"
import { republishLostRuns } from "@sixb/core/internal/workers"
import { DuckLakeStorage } from "@sixb/ducklake"
import { PostgresStorage } from "@sixb/pg"
import { PipelineWorker } from "@sixb/pipeline-worker"
import { BullMqQueues } from "@sixb/queues-bullmq"
import { SyncWorker } from "@sixb/sync-worker"

const [primitive, phase] = process.argv.slice(2) as ["sync" | "pipeline", string]

const stateDir = requireEnv("RECOVERY_STATE_DIR")

const projectId = "recovery-infra"
const runId = "run-1"

/** Short enough for a real lease to run out while the test waits, in the process that dies. */
const CRASHING_LEASE_MS = 1_500

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`[Test] ${name} is not set.`)
  return value
}

const source = defineDataset("source", { schema: [col("id", "string")] })
const orders = defineDataset("orders", { schema: [col("id", "string")] })

const erp = defineConnector("erp", {
  type: "test",
  connect() {
    return {}
  },
})

const ordersSync = defineSync("orders-sync", { mode: "append" })
  .checkpoint<string>()
  .from(erp)
  .read(async function* (_client, { checkpoint, setCheckpoint }) {
    yield { id: `after-${checkpoint ?? "start"}` }
    setCheckpoint("read-once")
  })
  .intoDataset(orders)

const fill = definePipelineStep("fill")
  .inputs({ source })
  .output(orders, { mode: "append" })
  .run(async ({ inputs, output }) => {
    await output.writeRows(inputs.source.readRows())
  })

const pipeline = definePipeline("orders-pipeline").then(fill)

mkdirSync(join(stateDir, "data"), { recursive: true })

const storage = new PostgresStorage({
  connectionString: requireEnv("RECOVERY_POSTGRES_URL"),
  schemaName: "sixb",
  max: 5,
})

const queues = new BullMqQueues({
  connection: requireEnv("RECOVERY_REDIS_URL"),
  stalledInterval: 500,
})

const lakeStorage = new DuckLakeStorage({
  catalog: {
    type: "postgres",
    host: "127.0.0.1",
    port: Number(requireEnv("RECOVERY_POSTGRES_PORT")),
    database: requireEnv("RECOVERY_POSTGRES_DATABASE"),
    user: "postgres",
    password: "test",
    metadataSchema: "lake",
  },
  dataPath: join(stateDir, "data"),
})

const host = new SixbHost({
  id: projectId,
  ontology: [],
  connectors: [erp],
  broker: new InMemoryBroker(),
  storage,
  lakeStorage,
  blobStorage: new InMemoryBlobStorage(),
  queues,
  datasets: [source, orders],
  syncs: [ordersSync],
  pipelines: [pipeline],
})

await migrateStorage(storage)

const syncRuns = storage.syncRuns
const pipelineRuns = storage.pipelineRuns

async function queueRun(): Promise<void> {
  const kind = primitive
  const definitionId = kind === "sync" ? ordersSync.id : pipeline.id

  await storage.executions.create({
    id: `exec:${runId}`,
    projectId,
    executor: { type: "primitive", kind, runId },
    source: { type: "schedule", eventId: `event:${runId}` },
    correlationId: `correlation:${runId}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind, id: definitionId, runId },
    },
  })

  if (kind === "sync") {
    await syncRuns.queue({
      id: runId,
      projectId,
      executionId: `exec:${runId}`,
      syncId: definitionId,
      datasetId: orders.id,
      mode: "append",
    })
    return
  }

  await pipelineRuns.queue({
    id: runId,
    projectId,
    executionId: `exec:${runId}`,
    pipelineId: definitionId,
  })
}

async function publishJob(id = runId): Promise<void> {
  if (primitive === "sync") {
    await queues.syncRuns.enqueue({
      projectId,
      jobs: [{ id, type: "sync.run.requested", payload: { runId } }],
    })
    return
  }

  await queues.pipelines.enqueue({
    projectId,
    jobs: [{ id, type: "pipeline.run.requested", payload: { runId } }],
  })
}

async function seedSource(): Promise<void> {
  await lakeStorage.createDataset(source)
  const seed = await lakeStorage.beginWrite({ dataset: source, mode: "snapshot" })
  await seed.writeRows([{ id: "row-1" }, { id: "row-2" }])
  await seed.commit()
}

function killRightAfterCommit(): void {
  const beginWrite = lakeStorage.beginWrite.bind(lakeStorage)

  lakeStorage.beginWrite = async (input) => {
    const session = await beginWrite(input)
    const commit = session.commit.bind(session)

    session.commit = async (commitInput) => {
      await commit(commitInput)
      process.kill(process.pid, "SIGKILL")
      throw new Error("[Test] SIGKILL does not return.")
    }
    return session
  }
}

/** A worker takes a real, short queue lease here. It never gets to renew it. */
function shortenTheQueueLease(): void {
  const lane = primitive === "sync" ? queues.syncRuns : queues.pipelines
  const claim = lane.claim.bind(lane)

  lane.claim = (input) => claim({ ...input, leaseMs: CRASHING_LEASE_MS }) as never
}

/** What a worker of the previous version wrote when it started a run: no token, and no lease. */
async function writeAsAnOldWorker(startedAt: string): Promise<void> {
  const sql = new Bun.SQL(requireEnv("RECOVERY_POSTGRES_URL"))
  const table = primitive === "sync" ? "sync_runs" : "pipeline_runs"

  await sql.unsafe(
    `UPDATE sixb.${table} SET status = 'running', started_at = ${startedAt}, attempt = 1
     WHERE id = '${runId}'`
  )
  await sql.close()
}

const readRun = () =>
  primitive === "sync"
    ? syncRuns.getById({ projectId, id: runId })
    : pipelineRuns.getById({ projectId, id: runId })

async function readOrders(): Promise<DatasetRow[]> {
  if (!(await lakeStorage.getLatestVersion(orders.id))) return []

  const rows: DatasetRow[] = []
  for await (const row of lakeStorage.readRows({ datasetId: orders.id })) rows.push(row)
  return rows
}

async function settled(): Promise<void> {
  for (;;) {
    const status = (await readRun())?.status
    if (status !== "queued" && status !== "running") return
    await Bun.sleep(25)
  }
}

const createWorker = () => (primitive === "sync" ? new SyncWorker(host) : new PipelineWorker(host))

function report(result: unknown): never {
  console.log(JSON.stringify(result))
  process.exit(0)
}

if (phase === "crash") {
  if (primitive === "pipeline") await seedSource()

  killRightAfterCommit()
  shortenTheQueueLease()

  await queueRun()
  await publishJob()
  await createWorker().start()
  await settled()

  throw new Error("[Test] The worker was meant to die right after its commit.")
}

if (phase === "resume") {
  await createWorker().start()
  await settled()

  report({ run: await readRun(), orders: await readOrders() })
}

/**
 * A rolling deploy: a worker of the previous version holds this run, and wrote what it knew how to
 * write. A job for the run reaches a worker of this version, which must leave it alone.
 */
if (phase === "old-worker") {
  await queueRun()
  await writeAsAnOldWorker("now()")

  const lane = primitive === "sync" ? queues.syncRuns : queues.pipelines
  const retry = lane.retry.bind(lane)
  let duplicatesHeld = 0
  lane.retry = async (input) => {
    duplicatesHeld += 1
    return retry(input)
  }

  await publishJob(`${runId}:from-the-old-dispatcher`)

  const worker = createWorker()
  await worker.start()
  while (duplicatesHeld === 0) await Bun.sleep(25)
  await worker.stop()

  const whileHeld = await readRun()

  // The old worker ends its run the only way it knows: with no token.
  if (primitive === "sync") {
    await syncRuns.finish({ projectId, id: runId, status: "succeeded", rowsRead: 0 })
  } else {
    await pipelineRuns.finish({ projectId, id: runId, status: "succeeded" })
  }

  report({ whileHeld, finished: await readRun() })
}

/** An old worker that died long ago: its run has no lease, and nothing else speaks for it. */
if (phase === "orphan") {
  await queueRun()
  await writeAsAnOldWorker("now() - interval '25 hours'")

  const result = await republishLostRuns({
    projectId,
    storage,
    queues,
    events: host.events,
    now: new Date(),
  })

  report({ result, run: await readRun() })
}

throw new Error(`[Test] Unknown phase '${phase}'.`)
