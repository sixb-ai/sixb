import { LocalBlobStorage } from "@sixb/blob-local"
import { NatsBroker } from "@sixb/broker-nats"
import { createSixb, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { PostgresStorage } from "@sixb/pg"

// Required environment variables:
//   PANASONIC_EMAIL    — Panasonic ID email
//   PANASONIC_PASSWORD — Panasonic ID password
// Optional environment variables:
//   PANASONIC_APP_VERSION — overrides automatic App Store version detection
//   DATABASE_URL       — PostgreSQL connection string
//   NATS_URL           — NATS server URL (defaults to nats://localhost:4222)

const pg = new PostgresStorage({
  connectionString: process.env.DATABASE_URL!,
})
const blobStorage = new LocalBlobStorage({ basePath: ".sixb" })

export const sixb = createSixb({
  id: "panasonic-ac",
  broker: new NatsBroker({
    connection: { servers: process.env.NATS_URL ?? "nats://localhost:4222" },
  }),
  storage: pg,
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage,
  queues: new InMemoryQueues(),
})
