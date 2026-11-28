import {
  defineMigration,
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
// this run defines, `SIXB_SHAPES_MIGRATION` which migration it declares, and `SIXB_SHAPES_SCHEMA`
// the test's own PostgreSQL schema.

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
  /** Renames `gate`, now unique and queried. */
  renamed: [
    prop("gateCode", "string", {
      unique: true,
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("hours", "string"),
  ],
  /** Makes `hours` a required number: a convert of the text values, a fill of the missing. */
  hourly: [prop("gate", "string"), prop("hours", "double", { required: true })],
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

/** `Job` as `hourly` declares it, which its migration's values are typed against. */
const HourlyJob = defineObjectType({
  id: "Job",
  name: "Job",
  properties: [
    prop("ref", "string", { primary: true, required: true }),
    prop("hours", "double", { required: true }),
  ],
})

const migrations = {
  none: [],
  /** Covers `withoutGate`'s removal. */
  removeGate: [defineMigration("job-gate", Job).removeProperty("gate")],
  /** Covers `renamed`'s rename. */
  renameGate: [defineMigration("job-gate-code", Job).renameProperty("gate", "gateCode")],
  /** Covers `hourly`'s narrowing: text to a number, and none to 0. */
  hours: [
    defineMigration("job-hours", HourlyJob)
      .convertProperty("hours", ({ value }) => {
        const hours = Number(value)
        if (Number.isNaN(hours)) throw new Error(`'${String(value)}' isn't a number`)
        return hours
      })
      .fillProperty("hours", () => 0),
  ],
  /** Gives the primary property a value: refused at load. */
  invalid: [defineMigration("job-ref", Job).fillProperty("ref", () => "R")],
  /** Removes a property `Job` declares again: inert, and `sixb check` says it can go. */
  inert: [defineMigration("job-hours", Job).removeProperty("hours")],
}

const migration = (process.env.SIXB_SHAPES_MIGRATION ?? "none") as keyof typeof migrations

export const sixb = new SixbHost({
  id: "cli-type-shapes",
  auth: { id: "disabled", kind: "disabled", allowDisabledInProduction: true },
  ontology: [Job],
  migrations: migrations[migration],
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
