/**
 * One process of the run recovery end-to-end test: a real sync and pipeline worker on SQLite and
 * DuckLake files, which `crash` phases kill with SIGKILL at a chosen point.
 *
 * bun process.ts <state directory> <sync|pipeline> <crash point|resume|lost-reply>
 *
 * `lost-reply` kills nothing: the first commit lands and answers with an error, as a connection
 * lost during COMMIT does, and the process runs on.
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
  InMemoryQueues,
  SixbHost,
} from "@sixb/core"
import { republishLostRuns } from "@sixb/core/internal/workers"
import { DuckLakeStorage } from "@sixb/ducklake"
import { PipelineWorker } from "@sixb/pipeline-worker"
import { migrateSqliteStorage, SqliteStorage } from "@sixb/sqlite"
import { SyncWorker } from "@sixb/sync-worker"

type Phase = "mid-read" | "after-commit" | "after-sql-commit" | "resume" | "lost-reply"

const [stateDir, primitive, phase] = process.argv.slice(2) as [string, "sync" | "pipeline", Phase]

const projectId = "recovery-e2e"
const runId = "run-1"

const source = defineDataset("source", { schema: [col("id", "string")] })
const orders = defineDataset("orders", { schema: [col("id", "string")] })
const published = defineDataset("published", { schema: [col("id", "string")] })

const erp = defineConnector("erp", {
  type: "test",
  connect() {
    return {}
  },
})

function die(point: Phase): void {
  if (phase === point) process.kill(process.pid, "SIGKILL")
}

const ordersSync = defineSync("orders-sync", { mode: "append" })
  .checkpoint<string>()
  .from(erp)
  .read(async function* (_client, { checkpoint, setCheckpoint }) {
    yield { id: `after-${checkpoint ?? "start"}` }
    die("mid-read")
    setCheckpoint("read-once")
  })
  .intoDataset(orders)

const fill = definePipelineStep("fill")
  .inputs({ source })
  .output(orders, { mode: "append" })
  .run(async ({ inputs, output }) => {
    await output.writeRows(inputs.source.readRows())
    die("mid-read")
  })

const publish = definePipelineStep("publish")
  .inputs({ orders })
  .output(published)
  .sql(({ orders }) => `SELECT id FROM ${orders}`)

const pipeline = definePipeline("orders-pipeline").then(fill).then(publish)

mkdirSync(join(stateDir, "lake"), { recursive: true })

const storagePath = join(stateDir, "storage")
await migrateSqliteStorage(storagePath)

const storage = new SqliteStorage({ path: storagePath })
const lakeStorage = new DuckLakeStorage({
  catalog: { type: "duckdb", path: join(stateDir, "lake", "catalog.ducklake") },
  dataPath: join(stateDir, "lake", "data"),
})

let replyLost = phase !== "lost-reply"

const beginWrite = lakeStorage.beginWrite.bind(lakeStorage)
lakeStorage.beginWrite = async (input) => {
  const session = await beginWrite(input)
  const commit = session.commit.bind(session)

  session.commit = async (commitInput) => {
    const committed = await commit(commitInput)
    die("after-commit")

    if (replyLost) return committed

    replyLost = true
    throw new Error("connection lost during COMMIT")
  }
  return session
}

const executeSql = lakeStorage.sql.execute.bind(lakeStorage.sql)
lakeStorage.sql.execute = async (input) => {
  const committed = await executeSql(input)
  die("after-sql-commit")
  return committed
}

const host = new SixbHost({
  id: projectId,
  ontology: [],
  connectors: [erp],
  broker: new InMemoryBroker(),
  storage,
  lakeStorage,
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
  datasets: [source, orders, published],
  syncs: [ordersSync],
  pipelines: [pipeline],
})

async function queueSyncRun(id: string): Promise<void> {
  await storage.executions.create({
    id: `exec:${id}`,
    projectId,
    executor: { type: "primitive", kind: "sync", runId: id },
    source: { type: "schedule", eventId: `event:${id}` },
    correlationId: `correlation:${id}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "sync", id: ordersSync.id, runId: id },
    },
  })
  await storage.syncRuns.queue({
    id,
    projectId,
    executionId: `exec:${id}`,
    syncId: ordersSync.id,
    datasetId: orders.id,
    mode: "append",
  })
  await host.queues.syncRuns.enqueue({
    projectId,
    jobs: [{ id, type: "sync.run.requested", payload: { runId: id } }],
  })
}

async function queuePipelineRun(id: string): Promise<void> {
  await storage.executions.create({
    id: `exec:${id}`,
    projectId,
    executor: { type: "primitive", kind: "pipeline", runId: id },
    source: { type: "schedule", eventId: `event:${id}` },
    correlationId: `correlation:${id}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "pipeline", id: pipeline.id, runId: id },
    },
  })
  await storage.pipelineRuns.queue({
    id,
    projectId,
    executionId: `exec:${id}`,
    pipelineId: pipeline.id,
  })
  await host.queues.pipelines.enqueue({
    projectId,
    jobs: [{ id, type: "pipeline.run.requested", payload: { runId: id } }],
  })
}

async function seedSource(): Promise<void> {
  await lakeStorage.createDataset(source)
  const seed = await beginWrite({ dataset: source, mode: "snapshot" })
  await seed.writeRows([{ id: "row-1" }, { id: "row-2" }])
  await seed.commit()
}

async function readRows(datasetId: string): Promise<DatasetRow[]> {
  if (!(await lakeStorage.getLatestVersion(datasetId))) return []

  const rows: DatasetRow[] = []
  for await (const row of lakeStorage.readRows({ datasetId })) rows.push(row)
  return rows
}

async function readRun(id = runId) {
  return primitive === "sync"
    ? storage.syncRuns.getById({ projectId, id })
    : storage.pipelineRuns.getById({ projectId, id })
}

async function settled(id: string): Promise<void> {
  for (;;) {
    const status = (await readRun(id))?.status
    if (status !== "queued" && status !== "running") return
    await Bun.sleep(10)
  }
}

const worker = primitive === "sync" ? new SyncWorker(host) : new PipelineWorker(host)

/** Runs what is left, then the next sync, which reads from the checkpoint this one paid for. */
async function finishAndReport(): Promise<never> {
  await settled(runId)

  if (primitive === "sync") {
    await queueSyncRun("run-2")
    await settled("run-2")
  }
  await worker.stop()

  console.log(
    JSON.stringify({
      run: await readRun(),
      orders: await readRows(orders.id),
      published: primitive === "pipeline" ? await readRows(published.id) : [],
      steps:
        primitive === "pipeline"
          ? (await storage.pipelineRuns.listSteps({ projectId, pipelineRunId: runId })).steps
          : [],
    })
  )
  process.exit(0)
}

if (phase === "resume") {
  await republishLostRuns({
    projectId,
    storage,
    queues: host.queues,
    events: host.events,
    now: new Date(),
  })
  await worker.start()
  await finishAndReport()
}

if (primitive === "sync") {
  await queueSyncRun(runId)
} else {
  await seedSource()
  await queuePipelineRun(runId)
}

await worker.start()
if (phase === "lost-reply") await finishAndReport()

await settled(runId)

// A crash phase never gets here.
throw new Error(`The worker was meant to die at '${phase}'.`)
