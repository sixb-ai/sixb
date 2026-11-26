import { expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineMigration,
  defineObjectType,
  defineProjection,
  type EmbeddingModel,
  type MigrationDefinition,
  OntologyRegistry,
  prop,
  SixbHost,
  type Storage,
} from ".."
import { InMemoryBlobStorage } from "../blob-storage"
import { InMemoryBroker } from "../broker"
import { restoreTrustedPrimitiveExecutionScope } from "../execution/durable"
import { createTestingScope } from "../execution/scopes"
import type { JsonValue } from "../json"
import { InMemoryLakeStorage } from "../lake-storage"
import {
  createOntologyMaterializer,
  type OntologyEditOperation,
  ProjectionRegistry,
  type ProjectionSourceEntry,
} from "../materializer"
import { resumeOntologyMigration } from "../migrations/run"
import { vectorSources } from "../objects/vectors/profile"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { Property } from "../ontology/types"
import { InMemoryQueues } from "../queues"
import { migrateStorage } from "../storage/migrations"
import type { OntologyMigrationRunRecord, OntologyMigrationStorage } from "../storage/ontology"
import { migrationRunTotals } from "../storage/ontology/migrations"
import { createTestSixb } from "./execution"
import { startTestProjectionRun } from "./projection-execution"

// Jobs whose `hours`, `status`, `code` and `rank` a first release stores as free text, in edits an
// action wrote, in a projection's rows, in a losing edit and in a subtype; then the releases that
// narrow each one, with the fills and converts that move the values.

const PROJECT = "ontology-migration-values"
const AT = "2026-05-01T00:00:00.000Z"
const TIMEOUT_MS = 30_000

const embedding: EmbeddingModel = {
  providerId: "test",
  modelId: "migration-values",
  definition: { kind: "embedding", providerId: "test", modelId: "migration-values", dimensions: 2 },
  async embed({ texts }) {
    return { vectors: texts.map((text) => [1, text.length]) }
  },
}

/** The first release's declarations; each later one narrows one of them. */
const first = {
  hours: prop("hours", "string"),
  status: prop("status", "string"),
  code: prop("code", "string", { unique: true }),
  rank: prop("rank", "string", { unique: true }),
}

function release<
  const H extends Property,
  const S extends Property,
  const C extends Property,
  const R extends Property,
>(hours: H, status: S, code: C, rank: R) {
  const Job = defineObjectType({
    id: "ValueJob",
    name: "Job",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      hours,
      status,
      code,
      rank,
    ],
    search: { vectors: { statuses: { source: ["status"], model: embedding } } },
  })
  const Inspection = defineObjectType({
    id: "ValueInspection",
    name: "Inspection",
    extends: Job,
    properties: [],
  })

  return { Job, Inspection, ontology: new OntologyRegistry({ sources: [Job, Inspection] }) }
}

const v1 = release(first.hours, first.status, first.code, first.rank)
const JOB = v1.Job.id
const INSPECTION = v1.Inspection.id

const jobs = defineDataset("migration_values_jobs", {
  schema: [col("id", "string"), col("hours", "string"), col("updated_at", "timestamp")],
})
const projection = defineProjection("migration_values_jobs", v1.Job)
  .fromDataset(jobs)
  .properties({ id: "id", hours: "hours" })
  .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })
const projections = new ProjectionRegistry({
  projections: [projection],
  ontology: v1.ontology,
  datasetsById: new Map<string, DatasetDefinition>([[jobs.id, jobs]]),
})

/** `hours` becomes a required number: a convert of the text values, a fill of the missing ones. */
const hourly = release(
  prop("hours", "double", { required: true }),
  first.status,
  first.code,
  first.rank
)

/** `status` keeps two values; `code` three, still unique; `rank` becomes a unique integer. */
const statuses = release(
  first.hours,
  prop("status", textEnum("open", "closed")),
  first.code,
  first.rank
)
const codes = release(
  first.hours,
  first.status,
  prop("code", textEnum("A", "B", "C"), { unique: true }),
  first.rank
)
const ranks = release(
  first.hours,
  first.status,
  first.code,
  prop("rank", "integer", { unique: true })
)

/** `code` keeps "a", "b" and "C": a convert may swap two objects' values. */
const swapping = release(
  first.hours,
  first.status,
  prop("code", textEnum("a", "b", "C"), { unique: true }),
  first.rank
)

/** `status` becomes required, and the projection feeds it from a new column. */
const required = release(
  first.hours,
  prop("status", "string", { required: true }),
  first.code,
  first.rank
)
const statusJobs = defineDataset("migration_values_jobs", {
  schema: [
    col("id", "string"),
    col("hours", "string"),
    col("status", "string"),
    col("updated_at", "timestamp"),
  ],
})
const feedingStatus = new ProjectionRegistry({
  projections: [
    defineProjection("migration_values_jobs", required.Job)
      .fromDataset(statusJobs)
      .properties({ id: "id", hours: "hours", status: "status" })
      .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" }),
  ],
  ontology: required.ontology,
  datasetsById: new Map<string, DatasetDefinition>([[statusJobs.id, statusJobs]]),
})

/** `rank` renamed `position`, now one of three values. */
const ranked = release(
  first.hours,
  first.status,
  first.code,
  prop("position", textEnum("1", "2", "3", "4", "5"), { unique: true })
)

/** `ranked`, with `position` required. */
const rankedRequired = release(
  first.hours,
  first.status,
  first.code,
  prop("position", textEnum("1", "2", "3", "4", "5"), { unique: true, required: true })
)

/** `hourly`, with `rank` renamed `position` in the same release. */
const positioned = release(
  prop("hours", "double", { required: true }),
  first.status,
  first.code,
  prop("position", "string", { unique: true })
)

function textEnum(...values: string[]) {
  return { type: "enum" as const, valueType: "string" as const, values }
}

/**
 * The fill first, so the convert sees the values it gave. Counts each call, to prove a resume
 * never calls a function again.
 */
function hourMigrations(calls = { fill: 0, convert: 0 }) {
  return [
    defineMigration("job-hours", hourly.Job)
      .fillProperty("hours", ({ object }) => {
        calls.fill += 1
        return object.status === "CLOSED" ? 8 : 0
      })
      .convertProperty("hours", ({ value }) => {
        calls.convert += 1
        const hours = Number(value)
        if (Number.isNaN(hours)) throw new Error(`'${String(value)}' isn't a number`)
        return hours
      }),
  ]
}

/**
 * Edit-created jobs `c-1` to `c-3` and inspection `i-1`; `c-4` and `c-5`, created by an action and
 * fed by the projection, whose rows name `hours` absent; `c-5` has no status; projected jobs `p-1`
 * (its edit wins), `p-2` (its edit loses to a newer row) and `p-3` (no hours at all).
 */
async function seedJobs(storage: Storage): Promise<void> {
  await migrateStorage(storage, {
    projectId: PROJECT,
    ontology: v1.ontology,
    ontologyShapes: "deploy",
  })

  const jobs = client(storage).objects(v1.Job)
  await jobs.upsert({ properties: { id: "c-1", hours: "3", status: "OPEN", code: "a", rank: "1" } })
  await jobs.upsert({ properties: { id: "c-2", status: "CLOSED", code: "b", rank: "2" } })
  await jobs.upsert({ properties: { id: "c-3", hours: "5", code: "c" } })
  await jobs.upsert({ properties: { id: "c-4", status: "CLOSED" } })
  await jobs.upsert({ properties: { id: "c-5" } })
  await client(storage)
    .objects(v1.Inspection)
    .upsert({ properties: { id: "i-1", hours: "7", status: "OPEN" } })

  // `p-2`'s row is newer than its edit: the edit loses.
  await publish(storage, [
    entry("p-1", at(1), "10"),
    entry("p-2", at(3), "22"),
    entry("p-3", at(1)),
    withAbsentHours(entry("c-4", at(1))),
    // A row from before the projection fed `status`: the next release's projection feeds it.
    entry("c-5", at(1)),
  ])
  await edits(storage, at(2)).commit([patch("p-1", { hours: "11" }), patch("p-2", { hours: "21" })])
}

/**
 * Fill and convert, on every provider: values given in edits only, never over a projection's;
 * nothing written when one object fails; unique keys checked in the staging, then updated or
 * rebuilt; vectors queued; a resume that never calls a function again.
 *
 * Removal proofs, each failing a case below: in core's plan, drop the `fed` check of a fill or
 * the `filled` set a convert skips; in a provider, apply the claims of `stagedUnique` before
 * every release ends, leave the vectors out of a batch, or bump the version again for a row the
 * key steps rewrote.
 */
export function runOntologyMigrationValueCases<TStorage extends Storage>(
  name: string,
  provider: {
    readonly createStorage: () => TStorage | Promise<TStorage>
    readonly cleanup?: (storage: TStorage) => void | Promise<void>
    /** Empties an edit's times, as legacy rows store them, for a provider that has such rows. */
    readonly clearEditTimes?: (
      storage: TStorage,
      ref: { readonly projectId: string; readonly objectTypeId: string; readonly primaryId: string }
    ) => Promise<void>
  }
): void {
  async function withSeeded(run: (storage: TStorage) => Promise<void>): Promise<void> {
    const storage = await provider.createStorage()
    try {
      // A provider without the staging refuses value steps at the gate: nothing to run here.
      if (!storage.ontology.migrations?.values) return

      await seedJobs(storage)
      await run(storage)
    } finally {
      await closeHosts(storage)
      await provider.cleanup?.(storage)
    }
  }

  // Removal proofs: drop the `fed` check of a fill, and `c-4` gets an edit over the projection's
  // absent value; drop the `filled` set, and the convert runs again over `c-2`'s filled 8.
  test(
    `${name} fills and converts values in edits only, keeping each edit's time`,
    async () => {
      await withSeeded(async (storage) => {
        const before = await readJobs(storage)
        const outbox = await storage.ontology.outbox.summarize({ projectId: PROJECT })
        const calls = { fill: 0, convert: 0 }

        const result = await deploy(storage, hourly.ontology, hourMigrations(calls))
        const run = result.migration
        if (!run) throw new Error("No run was planned.")

        const after = await readJobs(storage)
        const hours = (id: string) => after.get(id)?.effective?.properties.hours
        const ids = ["c-1", "c-2", "c-3", "i-1", "p-1", "p-2", "p-3", "c-4", "c-5"]
        expect(ids.map(hours)).toEqual([
          3,
          8,
          5,
          7,
          11,
          // A losing edit is converted; the projection's values are the projection's.
          "22",
          undefined,
          undefined,
          undefined,
        ])
        for (const id of ["c-4", "c-5"]) {
          expect(after.get(id)?.override?.value).toEqual(before.get(id)?.override?.value)
        }
        expect(after.get("p-2")?.override?.value).toEqual({
          kind: "patch",
          set: { hours: 21 },
          unset: [],
        })
        expect(after.get("p-2")?.source?.assertion.properties.hours).toBe("22")
        expect(after.get("p-3")?.override).toBeNull()

        // A convert keeps the edit's time; a fill is timed at the run's start.
        expect(after.get("c-1")?.override?.editedAt?.hours).toBe(
          before.get("c-1")?.override?.editedAt?.hours ?? "missing"
        )
        expect(after.get("c-2")?.override?.editedAt?.hours).toBe(run.startedAt)

        // One version more for each object whose values changed, and nothing else.
        for (const [id, state] of before) {
          const changed = ["c-1", "c-2", "c-3", "i-1", "p-1"].includes(id)
          expect({ id, version: after.get(id)?.effective?.version }).toEqual({
            id,
            version: (state.effective?.version ?? 0) + (changed ? 1 : 0),
          })
        }

        expect(calls).toEqual({ fill: 1, convert: 5 })
        expect(await storage.ontology.outbox.summarize({ projectId: PROJECT })).toEqual(outbox)
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in `coverChanges`, leave out `valueChanges`; the stored shape then has
  // `rank` and no `position`, no change maps to the convert, and `c-3` keeps " 1" under an enum
  // that refuses it, its migration settled.
  test(
    `${name} converts and fills a property a rename moves in the same run`,
    async () => {
      await withSeeded(async (storage) => {
        const jobs = client(storage).objects(v1.Job)
        await jobs.upsert({ properties: { id: "c-3", rank: " 3" } })

        const code = rankedRequired
        const rename = defineMigration("job-position", code.Job).renameProperty("rank", "position")
        const trim = defineMigration("job-position-values", code.Job)
          .convertProperty("position", ({ value }) => String(value).trim() as "1")
          .fillProperty("position", () => "1")
        const result = await deploy(storage, code.ontology, [rename, trim])

        // `i-1`, an inspection an action created without a rank, takes the fill; `c-4` and `c-5`
        // stand for source rows, which the gate leaves to their projection.
        const after = await readJobs(storage)
        const position = (id: string) => after.get(id)?.effective?.properties.position
        expect(["c-1", "c-2", "c-3", "i-1", "c-4", "c-5"].map(position)).toEqual([
          "1",
          "2",
          "3",
          "1",
          undefined,
          undefined,
        ])
        const steps = (objectTypeId: string) =>
          result.migration?.plan.types
            .find((type) => type.objectTypeId === objectTypeId)
            ?.steps.map((step) => step.kind)
        expect(steps(JOB)).toEqual(["renameProperty", "convertProperty"])
        expect(steps(INSPECTION)).toEqual(["fillProperty"])

        const settled = await storage.ontology.migrations?.listSettled({ projectId: PROJECT })
        for (const objectTypeId of [JOB, INSPECTION]) {
          expect(settled).toContainEqual({ objectTypeId, migrationId: "job-position-values" })
        }
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in a provider's `findUniqueCollisions`, look kept values up under the
  // property's own id; the plan then passes, and the run fails past its point of no return on
  // `c-1`'s "1", every resume with it.
  test(
    `${name} finds a unique key a rename's values hold, before the run`,
    async () => {
      await withSeeded(async (storage) => {
        await client(storage)
          .objects(v1.Job)
          .upsert({ properties: { id: "c-3", rank: " 1" } })
        const before = await dumpStores(storage)

        const rename = defineMigration("job-position", ranked.Job).renameProperty(
          "rank",
          "position"
        )
        const trim = defineMigration("job-position-values", ranked.Job).convertProperty(
          "position",
          ({ value }) => String(value).trim() as "1"
        )
        const failed = await deploy(storage, ranked.ontology, [rename, trim]).catch(
          (error: unknown) => error
        )

        expect(String(failed)).toContain(
          `ValueJob 'c-3': 'position' would take "1", which 'c-1' holds.`
        )
        expect(await dumpStores(storage)).toEqual(before)
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in the plan, read edit times as stored, without the legacy fallback to the
  // edit's update; `p-2`'s losing edit then wins once converted, and the job goes to 21.
  test(
    `${name} keeps a losing edit losing when its times are a legacy row's`,
    async () => {
      if (!provider.clearEditTimes) return

      await withSeeded(async (storage) => {
        await provider.clearEditTimes!(storage, {
          projectId: PROJECT,
          objectTypeId: JOB,
          primaryId: "p-2",
        })
        const before = await readJobs(storage)

        await deploy(storage, hourly.ontology, hourMigrations())

        const after = await readJobs(storage)
        expect(after.get("p-2")?.effective?.properties.hours).toBe("22")
        expect(after.get("p-2")?.effective?.version).toBe(before.get("p-2")?.effective?.version)
        expect(after.get("p-2")?.override?.value).toMatchObject({ set: { hours: 21 } })
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in the plan, fill a patch that cleared the property whatever feeds it; `p-1`
  // then gets an edit over the projection's `hours`.
  test(
    `${name} refuses a fill of a value an edit cleared over a projection`,
    async () => {
      await withSeeded(async (storage) => {
        await edits(storage, at(4)).commit([{ ...patch("p-1", {}, ["hours"]), id: "clear-p-1" }])
        const before = await dumpStores(storage)

        const failed = await deploy(storage, hourly.ontology, hourMigrations()).catch(
          (error: unknown) => error
        )

        expect(String(failed)).toContain(
          "ValueJob 'p-1': 'hours' was cleared by an edit over the projection's value"
        )
        expect(await dumpStores(storage)).toEqual(before)
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in the plan, drop `projected` from a fill's `fed`; `c-5` then gets an edit
  // timed at the run's start, which masks the value the projection gives on its next run.
  test(
    `${name} gives no value a projection of the new code feeds`,
    async () => {
      await withSeeded(async (storage) => {
        const fill = defineMigration("job-status", required.Job).fillProperty(
          "status",
          () => "open"
        )
        await deploy(storage, required.ontology, [fill], undefined, feedingStatus)

        const after = await readJobs(storage)
        expect(after.get("c-3")?.effective?.properties.status).toBe("open")
        expect(after.get("c-5")?.override?.value).toEqual({ kind: "create", properties: {} })
      })
    },
    TIMEOUT_MS
  )

  // Removal proofs: in the plan, refuse every patch that cleared the property, and `p-1` fails
  // the deploy; in a provider's staged batch, leave `restored` out of the patch's `unset`, and
  // `p-1`'s edit both sets and clears `status`.
  test(
    `${name} fills a value an edit cleared where no projection feeds it`,
    async () => {
      await withSeeded(async (storage) => {
        await edits(storage, at(4)).commit([{ ...patch("p-1", { status: "OPEN" }), id: "set-p-1" }])
        await edits(storage, at(5)).commit([{ ...patch("p-1", {}, ["status"]), id: "clear-p-1" }])

        const fill = defineMigration("job-status", required.Job).fillProperty(
          "status",
          () => "open"
        )
        const result = await deploy(storage, required.ontology, [fill])

        const p1 = (await readJobs(storage)).get("p-1")
        expect(p1?.override?.value).toEqual({
          kind: "patch",
          set: { hours: "11", status: "open" },
          unset: [],
        })
        expect(p1?.override?.editedAt?.status).toBe(result.migration?.startedAt ?? "missing")
        expect(p1?.effective?.properties.status).toBe("open")
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} names every object a function fails for, and writes nothing`,
    async () => {
      await withSeeded(async (storage) => {
        const jobs = client(storage).objects(v1.Job)
        await jobs.upsert({ properties: { id: "c-7", hours: "four" } })
        await jobs.upsert({ properties: { id: "c-8", hours: "five" } })
        const before = await dumpStores(storage)

        const failed = await deploy(storage, hourly.ontology, hourMigrations()).catch(
          (error: unknown) => error
        )

        expect(String(failed)).toContain(
          [
            "[Sixb] Migration 'job-hours' cannot apply: 2 objects fail.",
            "  ValueJob 'c-7': convertProperty('hours') failed: 'four' isn't a number",
            "  ValueJob 'c-8': convertProperty('hours') failed: 'five' isn't a number",
            "Nothing was written.",
          ].join("\n")
        )
        expect(await dumpStores(storage)).toEqual(before)
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: drop the kept-value query of `findUniqueCollisions`, and `c-3` takes `c-8`'s
  // value after the point of no return.
  test(
    `${name} finds unique keys staged twice, or kept by another object, and writes nothing`,
    async () => {
      await withSeeded(async (storage) => {
        const jobs = client(storage).objects(v1.Job)
        await jobs.upsert({ properties: { id: "c-7", code: " a" } })
        await jobs.upsert({ properties: { id: "c-8", code: "C" } })
        const before = await dumpStores(storage)

        const upper = defineMigration("job-code", codes.Job).convertProperty("code", ({ value }) =>
          String(value).trim().toUpperCase()
        )
        const failed = await deploy(storage, codes.ontology, [upper]).catch(
          (error: unknown) => error
        )

        expect(String(failed)).toContain(
          [
            "[Sixb] Migration 'job-code' cannot apply: 3 objects fail.",
            `  ValueJob 'c-1': 'code' would take "A", as would 'c-7'.`,
            `  ValueJob 'c-3': 'code' would take "C", which 'c-8' holds.`,
          ].join("\n")
        )
        // Every object is named: none is left to count.
        expect(String(failed)).not.toContain("more.")
        expect(await dumpStores(storage)).toEqual(before)
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in a provider's `stagedUnique`, start with the claims; `c-1` then claims "b"
  // while `c-2` still holds it. Drop the `releasing` exclusion of `findUniqueCollisions`, and the
  // swap is refused before the run.
  test(
    `${name} updates unique values from the staged keys, two objects swapping theirs`,
    async () => {
      await withSeeded(async (storage) => {
        // `c-1` takes `c-2`'s "b" and `c-2` takes `c-1`'s "a", a batch apart.
        const swapped: Readonly<Record<string, string>> = { a: "b", b: "a", c: "C" }
        const swap = defineMigration("job-code", swapping.Job).convertProperty(
          "code",
          ({ value }) => swapped[String(value)] as "a"
        )
        await deploy(storage, swapping.ontology, [swap], 1)

        for (const [valueKey, holder] of [
          ["a", "c-2"],
          ["b", "c-1"],
          ["C", "c-3"],
          ["c", undefined],
        ] as const) {
          const held = await storage.objects.getByUniqueValue({
            projectId: PROJECT,
            objectTypeId: JOB,
            propertyId: "code",
            valueKey,
          })
          expect({ valueKey, holder: held?.primaryId }).toEqual({ valueKey, holder })
        }

        const taken = await client(storage, swapping)
          .objects(swapping.Job)
          .upsert({ properties: { id: "c-9", code: "C" } })
          .catch((error: unknown) => error)
        expect(String(taken)).toContain("already has this 'code'")
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in the plan, skip `findUniqueCollisions`; the duplicate then fails in the
  // unique preparation after the run, past its point of no return, with every job converted.
  test(
    `${name} rebuilds a unique property whose keys change kind, refusing duplicates first`,
    async () => {
      await withSeeded(async (storage) => {
        const toNumber = defineMigration("job-rank", ranks.Job).convertProperty(
          "rank",
          ({ value }) => Number(value)
        )

        await client(storage)
          .objects(v1.Job)
          .upsert({ properties: { id: "c-3", rank: "01" } })
        const before = await dumpStores(storage)
        const failed = await deploy(storage, ranks.ontology, [toNumber]).catch(
          (error: unknown) => error
        )
        expect(String(failed)).toContain(`ValueJob 'c-1': 'rank' would take "1", as would 'c-3'.`)
        expect(await dumpStores(storage)).toEqual(before)

        await client(storage)
          .objects(v1.Job)
          .upsert({ properties: { id: "c-3", rank: "3" } })
        await deploy(storage, ranks.ontology, [toNumber])

        const prepared = await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })
        expect(
          prepared.find(
            (property) => property.objectTypeId === JOB && property.propertyId === "rank"
          )?.keyKind
        ).toBe("integer")
        const held = await storage.objects.getByUniqueValue({
          projectId: PROJECT,
          objectTypeId: JOB,
          propertyId: "rank",
          valueKey: "1",
        })
        expect(held?.primaryId).toBe("c-1")
        const taken = await client(storage, ranks)
          .objects(ranks.Job)
          .upsert({ properties: { id: "c-9", rank: 2 } })
          .catch((error: unknown) => error)
        expect(String(taken)).toContain("already has this 'rank'")
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: leave the vector requests out of a provider's staged batch (`AND false`); the
  // work stays the one the first release queued, for "OPEN".
  test(
    `${name} queues vector indexing for the objects whose source values changed`,
    async () => {
      await withSeeded(async (storage) => {
        const lower = defineMigration("job-status", statuses.Job).convertProperty(
          "status",
          ({ value }) => String(value).toLowerCase() as "open"
        )
        const result = await deploy(storage, statuses.ontology, [lower])
        const run = result.migration!

        const due = await storage.ontology.vectorIndexing!.listDue({
          projectId: PROJECT,
          now: "2100-01-01T00:00:00.000Z",
          limit: 100,
        })
        const work = (id: string, objectTypeId: string) =>
          due.find((item) => item.ref.objectTypeId === objectTypeId && item.ref.primaryId === id)

        for (const [id, objectTypeId, status] of [
          ["c-1", JOB, "open"],
          ["c-2", JOB, "closed"],
        ] as const) {
          expect(work(id, objectTypeId)).toMatchObject({
            profile: "statuses",
            status: "pending",
            sourceFingerprint: vectorSources(["status"], { status }).sourceFingerprint,
          })
          expect(work(id, objectTypeId)?.sourceCommitId.startsWith(run.id)).toBe(true)
        }
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: in a provider's staged batch, bump the version of every staged object, also one
  // its key steps rewrote in the batch; `c-1` then goes two versions up, and counts twice.
  test(
    `${name} applies a rename and value steps to one object in one batch, one version up`,
    async () => {
      await withSeeded(async (storage) => {
        const before = await readJobs(storage)
        const rename = defineMigration("job-position", positioned.Job).renameProperty(
          "rank",
          "position"
        )
        const result = await deploy(storage, positioned.ontology, [rename, ...hourMigrations()])

        const after = await readJobs(storage)
        expect(after.get("c-1")?.effective?.properties).toMatchObject({ position: "1", hours: 3 })
        expect(after.get("c-1")?.effective?.properties).not.toHaveProperty("rank")
        expect(after.get("c-2")?.override?.value).toMatchObject({
          kind: "create",
          properties: { position: "2", hours: 8 },
        })
        for (const id of ["c-1", "c-2", "p-1"]) {
          expect({ id, version: after.get(id)?.effective?.version }).toEqual({
            id,
            version: (before.get(id)?.effective?.version ?? 0) + 1,
          })
        }
        expect(migrationRunTotals(result.migration!).counts.objects).toBe(5)

        const held = await storage.objects.getByUniqueValue({
          projectId: PROJECT,
          objectTypeId: JOB,
          propertyId: "position",
          valueKey: "1",
        })
        expect(held?.primaryId).toBe("c-1")
      })
    },
    TIMEOUT_MS
  )

  // Removal proof: make a provider's `startRun` drop the run's own staging instead of the others';
  // the resumed batches then apply nothing, and `c-2` has no hours. The functions' counts can only
  // stay: nothing outside the plan calls them.
  test(
    `${name} resumes a run from its staged values, never calling a function again`,
    async () => {
      await withSeeded(async (storage) => {
        const before = await readJobs(storage)
        const calls = { fill: 0, convert: 0 }
        const crashing = batching(storage, 2, 2)
        const crashed = await deploy(crashing, hourly.ontology, hourMigrations(calls)).catch(
          (error: unknown) => error
        )
        expect(String(crashed)).toContain("Run `sixb db migrate` to resume it.")
        expect(calls).toEqual({ fill: 1, convert: 5 })

        const resumed = await resumeOntologyMigration({ storage, projectId: PROJECT, batchRows: 2 })
        expect(resumed?.status).toBe("applied")
        expect(calls).toEqual({ fill: 1, convert: 5 })

        const after = await readJobs(storage)
        expect(after.get("c-2")?.effective?.properties.hours).toBe(8)
        expect(after.get("p-1")?.effective?.properties.hours).toBe(11)
        expect(after.get("c-1")?.effective?.version).toBe(
          (before.get("c-1")?.effective?.version ?? 0) + 1
        )
      })
    },
    TIMEOUT_MS
  )
}

/** The whole deploy step, as `sixb db migrate` runs it, with the run it applied. */
async function deploy(
  storage: Storage,
  ontology: OntologyRegistry,
  migrations: readonly MigrationDefinition[],
  batchRows?: number,
  feeding: ProjectionRegistry = projections
) {
  // The code's projections, as the CLI passes them: a fill gives no value a projection feeds.
  const options = {
    projectId: PROJECT,
    ontology,
    migrations,
    projections: feeding,
    ontologyShapes: "deploy",
  } as const

  let migration: OntologyMigrationRunRecord | undefined
  const watched = finishing(batchRows ? batching(storage, batchRows) : storage, (run) => {
    migration = run
  })
  const result = await migrateStorage(watched, options)

  return { ...result, migration }
}

/** `storage`, which hands the run `finishRun` returns to `onFinished`. */
function finishing<TStorage extends Storage>(
  storage: TStorage,
  onFinished: (run: OntologyMigrationRunRecord) => void
): TStorage {
  const migrations = storage.ontology.migrations!
  const watched: OntologyMigrationStorage = Object.create(migrations, {
    finishRun: {
      value: async (input: Parameters<OntologyMigrationStorage["finishRun"]>[0]) => {
        const run = await migrations.finishRun(input)
        onFinished(run)
        return run
      },
    },
  })

  return withMigrations(storage, watched)
}

/**
 * `storage`, whose migration batches cover at most `batchRows` rows, and fail once `crashAfter` of
 * them applied.
 */
function batching<TStorage extends Storage>(
  storage: TStorage,
  batchRows: number,
  crashAfter = Number.POSITIVE_INFINITY
): TStorage {
  const migrations = storage.ontology.migrations!
  let applied = 0
  const crashing: OntologyMigrationStorage = Object.create(migrations, {
    applyBatch: {
      value: async (input: Parameters<OntologyMigrationStorage["applyBatch"]>[0]) => {
        if (applied === crashAfter) throw new Error("the process was killed")
        applied += 1
        return migrations.applyBatch({ ...input, batchRows })
      },
    },
  })

  return withMigrations(storage, crashing)
}

/** `storage`, whose ontology answers with `migrations`. */
function withMigrations<TStorage extends Storage>(
  storage: TStorage,
  migrations: OntologyMigrationStorage
): TStorage {
  const ontology = new Proxy(storage.ontology, {
    get: (target, key) => (key === "migrations" ? migrations : Reflect.get(target, key)),
  })
  return new Proxy(storage, {
    get(target, key) {
      if (key === "ontology") return ontology
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function readJobs(storage: Storage) {
  const refs = [
    ...["c-1", "c-2", "c-3", "c-4", "c-5", "p-1", "p-2", "p-3"].map((primaryId) => ({
      objectTypeId: JOB,
      primaryId,
    })),
    { objectTypeId: INSPECTION, primaryId: "i-1" },
  ]
  const state = await storage.ontology.materializations.readState({
    projectId: PROJECT,
    objects: refs,
    links: [],
    linkScopes: [],
  })
  return new Map(state.objects.map((row) => [row.ref.primaryId, row]))
}

/** Every store a value step writes, as stored: compared whole before and after a failed run. */
async function dumpStores(storage: Storage) {
  const objects = []
  const edits = []
  for (const objectTypeId of [JOB, INSPECTION]) {
    const page = await storage.objects.listByPrimaryIdPage({
      projectId: PROJECT,
      objectTypeId,
      limit: 100,
    })
    objects.push(...page.objects.map(({ score: _score, ...object }) => object))
    const stored = await storage.ontology.typeShapes.listEdits({
      projectId: PROJECT,
      objectTypeId,
      limit: 100,
    })
    edits.push(...stored.edits)
  }

  return {
    objects,
    edits,
    shapes: await storage.ontology.typeShapes.list({ projectId: PROJECT }),
    commits: (await storage.ontology.commits.list({ projectId: PROJECT, limit: 1 })).total,
    openRun: await storage.ontology.migrations?.getOpenRun({ projectId: PROJECT }),
    unique: await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT }),
  }
}

const hosts = new WeakMap<Storage, SixbHost[]>()

/** A release's trusted client, the first one's by default: what its actions write. */
function client(
  storage: Storage,
  code: {
    readonly Job: ObjectTypeWithPropertyTokens
    readonly Inspection: ObjectTypeWithPropertyTokens
  } = v1
) {
  const host = new SixbHost({
    id: PROJECT,
    ontology: [code.Job, code.Inspection],
    models: { embedding: [embedding] },
    blobStorage: new InMemoryBlobStorage(),
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
    storage,
  })
  hosts.set(storage, [...(hosts.get(storage) ?? []), host])
  return createTestSixb(host)
}

async function closeHosts(storage: Storage): Promise<void> {
  for (const host of hosts.get(storage) ?? []) await host.closeBroker()
  hosts.delete(storage)
}

function at(seconds: number): string {
  return new Date(Date.parse(AT) + seconds * 1_000).toISOString()
}

function materializerFor(storage: Storage, committedAt: string) {
  return createOntologyMaterializer({
    projectId: PROJECT,
    ontology: v1.ontology,
    projections: projections,
    storage,
    dependencies: {
      batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 },
      clock: () => new Date(committedAt),
    },
  })
}

function edits(storage: Storage, committedAt: string) {
  const materializer = materializerFor(storage, committedAt).withScope(
    createTestingScope({
      projectId: PROJECT,
      executionId: "migration-values-execution",
      requestId: "migration-values-request",
      correlationId: "migration-values-correlation",
    })
  )

  return {
    commit(operations: readonly OntologyEditOperation[]) {
      return materializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: `migration-values-${crypto.randomUUID()}` },
        operations,
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    },
  }
}

function patch(
  primaryId: string,
  set: Readonly<Record<string, JsonValue>>,
  unset: readonly string[] = []
): OntologyEditOperation {
  return {
    id: `patch-${primaryId}`,
    kind: "object.patch",
    ref: { objectTypeId: JOB, primaryId },
    set,
    unset,
    reset: [],
  }
}

/** One dataset row: the job's projected `hours`, updated at `sourceUpdatedAt`. */
function entry(primaryId: string, sourceUpdatedAt: string, hours?: string): ProjectionSourceEntry {
  const ref = { objectTypeId: JOB, primaryId }
  return {
    root: { kind: "object", ref },
    assertions: [
      {
        kind: "object",
        ref,
        properties: hours === undefined ? { id: primaryId } : { id: primaryId, hours },
        sourceUpdatedAt,
      },
    ],
  }
}

/** The entry with its object's `hours` named absent, as a row with a null in that column. */
function withAbsentHours(value: ProjectionSourceEntry): ProjectionSourceEntry {
  return {
    ...value,
    assertions: value.assertions.map((assertion) =>
      assertion.kind === "object" ? { ...assertion, absentSourcePropertyIds: ["hours"] } : assertion
    ),
  }
}

/** Publishes the projection's source: `entries`, committed at the first instant. */
async function publish(storage: Storage, entries: readonly ProjectionSourceEntry[]) {
  const committedAt = at(1)
  const datasetVersion = { datasetId: jobs.id, versionId: "values-v1", createdAt: committedAt }
  const resolved = projections.resolveSource(projection.id)
  const runId = "migration-values-run"
  const { execution } = await startTestProjectionRun(storage, {
    id: runId,
    projectId: PROJECT,
    identity: {
      projectionId: projection.id,
      datasetVersion,
      ontologyRevision: resolved.ontologyRevision,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
      projectionKind: "object",
      protocol: "replacement",
    },
    target: { objectTypeId: JOB },
  })

  const stored = await storage.executions.getById({
    projectId: PROJECT,
    id: `test_projection_execution:${runId}`,
  })
  if (!stored) throw new Error(`Test execution for '${runId}' is missing.`)

  const bound = materializerFor(storage, committedAt).withScope(
    restoreTrustedPrimitiveExecutionScope({
      execution: stored,
      primitive: { kind: "projection", id: projection.id, runId },
    })
  )

  return bound.projections.replace({
    source: { projectionId: projection.id },
    datasetVersion,
    execution,
    entries: (async function* () {
      yield* entries
    })(),
  })
}
