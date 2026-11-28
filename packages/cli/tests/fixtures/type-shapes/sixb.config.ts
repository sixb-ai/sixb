import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  InMemoryQueues,
  prop,
  type Queues,
  SixbHost,
} from "@sixb/core"
import { PostgresStorage } from "@sixb/pg"
import { SharedBroker } from "../shared/sharedBroker"

// One project, deployed as several releases of its code: `SIXB_SHAPES_RELEASE` picks which `Job`
// this run defines, and `SIXB_SHAPES_SCHEMA` the test's own PostgreSQL schema.

const releases = {
  /** The release whose shape is recorded first. */
  first: [prop("gate", "string"), prop("hours", "string")],
  /** Adds an optional property: compatible. */
  withNote: [prop("gate", "string"), prop("hours", "string"), prop("note", "string")],
  /** Removes `gate`: a narrowing, which data may hold. */
  withoutGate: [prop("hours", "string")],
  /** Makes `gate` an integer: a narrowing both ways, which a role refuses. */
  retypedGate: [prop("gate", "integer"), prop("hours", "string")],
  /** Makes `gate` unique: a narrowing unique preparation checks. */
  uniqueGate: [prop("gate", "string", { unique: true }), prop("hours", "string")],
}

const release = (process.env.SIXB_SHAPES_RELEASE ?? "first") as keyof typeof releases

/** Queues that declare themselves shared, and fail their health check when asked to. */
const queues = Object.assign(new InMemoryQueues(), {
  scope: "shared",
  ...(process.env.SIXB_SHAPES_QUEUES_DOWN === "1"
    ? { health: () => Promise.reject(new Error("queues are down")) }
    : {}),
}) as unknown as Queues

const Job = defineObjectType({
  id: "Job",
  name: "Job",
  properties: [prop("ref", "string", { primary: true, required: true }), ...releases[release]],
})

export const sixb = new SixbHost({
  id: "cli-type-shapes",
  auth: { id: "disabled", kind: "disabled", allowDisabledInProduction: true },
  ontology: [Job],
  // Declared shared, so a production role boots past the shareability guard on one test host.
  broker: new SharedBroker(),
  queues,
  storage: new PostgresStorage({
    connectionString: process.env.DATABASE_URL ?? "",
    schemaName: process.env.SIXB_SHAPES_SCHEMA ?? "sixb",
  }),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
})
