import { basename, join } from "node:path"
import { RedisBroker } from "@sixb/broker-redis"
import {
  change,
  col,
  defineConnector,
  defineDataset,
  defineWebhook,
  InMemoryBlobStorage,
  SixbHost,
} from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { BullMqQueues } from "@sixb/queues-bullmq"
import { SqliteStorage } from "@sixb/sqlite"

const { SIXB_E2E_DIR: directory, SIXB_E2E_REDIS_URL: redisUrl } = process.env
if (!directory || !redisUrl) {
  throw new Error("[ingest-roles fixture] SIXB_E2E_DIR and SIXB_E2E_REDIS_URL are required.")
}

export const people = defineDataset("raw.people", {
  schema: [col("id", "string"), col("name", "string")],
  primaryKey: "id",
})

const crm = defineConnector("crm", {
  type: "test",
  connect: () => ({}),
  webhooks: [
    defineWebhook("person")
      .post()
      .json({ parse: (value: unknown) => value as { id: string; name: string } })
      .idempotencyKey(({ request }) => request.headers.get("x-delivery"))
      .handle(async ({ sixb, body }) => {
        const result = await sixb.datasets.ingest(people, { changes: [change.upsert(body)] })
        return { status: 200, body: { changes: result.changes } }
      }),
  ],
})

// Each test has its own directory, and so its own keys in the Redis the tests share.
const prefix = `ingest-roles-${basename(directory)}`

const queues = new BullMqQueues({ connection: redisUrl, prefix })

// A queue that refuses: what `ingest` must survive and the orchestrator's `ingest` pass repairs.
if (process.env.SIXB_E2E_REFUSE_ENQUEUE) {
  queues.lake.enqueue = async () => {
    throw new Error("[ingest-roles fixture] The queue refuses this job.")
  }
}

export const sixb = new SixbHost({
  id: "ingest-roles",
  ontology: [],
  datasets: [people],
  connectors: [crm],
  storage: new SqliteStorage({ path: join(directory, "storage.db") }),
  lakeStorage: new LocalLakeStorage({ path: join(directory, "lake") }),
  blobStorage: new InMemoryBlobStorage(),
  broker: new RedisBroker({ connection: { url: redisUrl }, prefix }),
  queues,
  lakeMaintenance: { enabled: false },
  auth: { id: "disabled", kind: "disabled", allowDisabledInProduction: true },
})
