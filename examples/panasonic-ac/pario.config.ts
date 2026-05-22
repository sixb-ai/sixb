import { LocalBlobStorage } from "@pario/blob-local"
import { NatsBroker } from "@pario/broker-nats"
import { createPario, InMemoryQueues } from "@pario/core"
import { LocalLakeStorage } from "@pario/lake-local"
import { PostgresStorage } from "@pario/pg"

// Required environment variables:
//   PANASONIC_EMAIL    — Panasonic ID email
//   PANASONIC_PASSWORD — Panasonic ID password
//   DATABASE_URL       — PostgreSQL connection string
//   NATS_URL           — NATS server URL (defaults to nats://localhost:4222)

const pg = new PostgresStorage({
  connectionString: process.env.DATABASE_URL!,
})
const blobStorage = new LocalBlobStorage({ basePath: ".pario" })

export const pario = createPario({
  id: "panasonic-ac",
  broker: new NatsBroker({
    connection: { servers: process.env.NATS_URL ?? "nats://localhost:4222" },
  }),
  storage: pg,
  lakeStorage: new LocalLakeStorage({ path: ".pario/lake" }),
  blobStorage,
  queues: new InMemoryQueues(),
})
