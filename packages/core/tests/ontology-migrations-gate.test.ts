import { describe, expect, test } from "bun:test"
import {
  defineMigration,
  defineObjectType,
  InMemoryStorage,
  link,
  type MigrationDefinition,
  migrateStorage,
  type ObjectTypeWithPropertyTokens,
  OntologyRegistry,
  type Property,
  prop,
  type Storage,
  stringEnum,
} from "../src"
import { createTestingScope } from "../src/execution/scopes"
import type { JsonValue } from "../src/json"
import {
  createOntologyMaterializer,
  type OntologyEditOperation,
  ProjectionRegistry,
} from "../src/materializer"
import type { ObjectLink } from "../src/ontology/types"
import { TypeShapeMismatchError } from "../src/storage/internal"
import { prepareUniqueProperties } from "../src/storage/migrations/prepare-unique-properties"
import type { OntologyMigrationStorage } from "../src/storage/ontology/migrations"

// The deploy's gate with the project's migrations: a change their pending steps cover isn't
// missing one, one they don't says what to write, a covered removal or rename runs, and a covered
// change of a kind this build can't apply yet still stops on data. The pending algorithm alone is in
// `ontology-migrations-pending`, what a run writes in the shared migration suite.

const PROJECT = "migrations-gate"

const Technician = defineObjectType({
  id: "GateTechnician",
  name: "Technician",
  properties: [prop("id", "string", { primary: true, required: true })],
})

function release(
  properties: readonly Property[],
  links: readonly ObjectLink[] = [],
  subtypes = false
) {
  const Job = defineObjectType({
    id: "Job",
    name: "Job",
    properties: [prop("ref", "string", { primary: true, required: true }), ...properties],
    links: [...links],
  })
  const Inspection = defineObjectType({
    id: "Inspection",
    name: "Inspection",
    extends: Job,
    properties: [],
  })
  const sources: ObjectTypeWithPropertyTokens[] = [
    Job,
    Technician,
    ...(subtypes ? [Inspection] : []),
  ]
  return { Job, Inspection, ontology: new OntologyRegistry({ sources }) }
}

const v1 = release([prop("gate", "string"), prop("hours", "string")], [link("crew", Technician)])

function deploy(
  storage: Storage,
  code: ReturnType<typeof release>,
  migrations: readonly MigrationDefinition[] = []
) {
  return migrateStorage(storage, {
    projectId: PROJECT,
    ontology: code.ontology,
    migrations,
    ontologyShapes: "deploy",
  })
}

async function storedJob(storage: Storage) {
  const rows = await storage.ontology.typeShapes.list({ projectId: PROJECT })
  return rows.find((row) => row.objectTypeId === "Job")
}

async function commit(
  storage: Storage,
  ontology: OntologyRegistry,
  operations: readonly OntologyEditOperation[]
) {
  const materializer = createOntologyMaterializer({
    projectId: PROJECT,
    ontology,
    projections: new ProjectionRegistry({ projections: [], ontology, datasetsById: new Map() }),
    storage,
  }).withScope(
    createTestingScope({
      projectId: PROJECT,
      executionId: "gate-execution",
      requestId: "gate-request",
      correlationId: "gate-correlation",
    })
  )

  await materializer.edits.commit({
    mode: "atomic",
    source: { kind: "runtime", requestId: `gate-${crypto.randomUUID()}` },
    operations,
    expectedObjects: [],
    expectedLinks: [],
    expectedLinkScopes: [],
  })
}

function create(
  ref: string,
  properties: Readonly<Record<string, JsonValue>> = {},
  objectTypeId = "Job"
): OntologyEditOperation {
  return {
    id: `create-${objectTypeId}-${ref}`,
    kind: "object.create",
    ref: { objectTypeId, primaryId: ref },
    properties: { ref, ...properties },
  }
}

/** A store on v1, with `jobs` created by actions. */
async function deployed(jobs: readonly OntologyEditOperation[], code = v1): Promise<Storage> {
  const storage = new InMemoryStorage()
  await deploy(storage, code)
  if (jobs.length > 0) await commit(storage, code.ontology, jobs)
  return storage
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(TypeShapeMismatchError)
  return (error as Error).message
}

describe("a change no migration covers writes the missing line", () => {
  test("a new required property: fill it", async () => {
    const storage = await deployed([create("J-1")])
    const v2 = release(
      [
        prop("gate", "string"),
        prop("hours", "string"),
        prop("crewLead", "string", { required: true }),
      ],
      [link("crew", Technician)]
    )

    expect(await messageOf(deploy(storage, v2))).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Job: 'crewLead' was added as required, and 1 object lacks it: created without it or cleared by an edit.",
        "    Fill it in a migration:",
        '      defineMigration("job-crew-lead", Job).fillProperty("crewLead", ({ object }) => …)',
      ].join("\n")
    )
  })

  test("a narrowed schema: convert the edits", async () => {
    const storage = await deployed([create("J-1", { hours: "three" })])
    const v2 = release(
      [prop("gate", "string"), prop("hours", "double")],
      [link("crew", Technician)]
    )

    expect(await messageOf(deploy(storage, v2))).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Job: 'hours' changed from string to double, and 1 object holds edits it no longer accepts.",
        "    Convert them in a migration:",
        '      defineMigration("job-hours", Job).convertProperty("hours", ({ value }) => …)',
      ].join("\n")
    )
  })

  test("a removed link: remove it", async () => {
    const storage = await deployed([
      create("J-1"),
      {
        id: "tech",
        kind: "object.create",
        ref: { objectTypeId: Technician.id, primaryId: "T-1" },
        properties: { id: "T-1" },
      },
      {
        id: "crew",
        kind: "link.upsert",
        ref: {
          source: { objectTypeId: "Job", primaryId: "J-1" },
          linkId: "crew",
          target: { objectTypeId: Technician.id, primaryId: "T-1" },
        },
      },
    ])
    const v2 = release([prop("gate", "string"), prop("hours", "string")])

    expect(await messageOf(deploy(storage, v2))).toContain(
      [
        "  ✗ Job: link 'crew' was removed, and 1 object holds it.",
        "    Remove it in a migration:",
        '      defineMigration("job-crew", Job).removeLink("crew")',
      ].join("\n")
    )
  })

  test("a subtype's line names the type it inherits the property from", async () => {
    const withSubtypes = release([prop("gate", "string"), prop("hours", "string")], [], true)
    const storage = await deployed([create("I-1", { gate: "B12" }, "Inspection")], withSubtypes)

    const v2 = release([prop("hours", "string")], [], true)
    expect(await messageOf(deploy(storage, v2))).toContain(
      [
        "  ✗ Inspection: 'gate' was removed, and 1 object holds it.",
        "    Rename or remove it in a migration:",
        '      defineMigration("job-gate", Job).renameProperty("gate", "<new id>")',
        '      defineMigration("job-gate", Job).removeProperty("gate")',
      ].join("\n")
    )
  })

  test("a rename the stored shape blocks says why, then what else would do", async () => {
    const storage = await deployed(
      [create("J-1", { gate: "B12", gateCode: "C3" })],
      release([prop("gate", "string"), prop("gateCode", "string")])
    )
    const v2 = release([prop("gateCode", "string")])
    const migration = defineMigration("job-gate", v2.Job).renameProperty("gate", "gateCode")

    expect(await messageOf(deploy(storage, v2, [migration]))).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Job: 'gate' was removed, and 1 object holds it.",
        "    Migration 'job-gate' renames 'gate' to 'gateCode', which can't run: the stored Job already has 'gateCode'.",
        "    Rename or remove it in a migration:",
        // `job-gate` is taken: the suggested migration is a new one.
        '      defineMigration("job-gate-2", Job).renameProperty("gate", "<new id>")',
        '      defineMigration("job-gate-2", Job).removeProperty("gate")',
      ].join("\n")
    )
  })

  // Guard proof: in `probeChanges`, read `change.propertyId` instead of `storedKey(...)`; the
  // edits under `gate` are never read, nothing is found unfit, and the deploy records a shape
  // whose `gateCode` the stored text doesn't fit.
  test("what a rename leaves unfit is read under the key the data still has", async () => {
    const storage = await deployed([create("J-1", { gate: "B12" })])
    const v2 = release(
      [prop("gateCode", "double"), prop("hours", "string")],
      [link("crew", Technician)]
    )
    const migration = defineMigration("job-gate", v2.Job).renameProperty("gate", "gateCode")

    expect(await messageOf(deploy(storage, v2, [migration]))).toContain(
      [
        "  ✗ Job: 'gateCode' changed from string to double, and 1 object holds edits it no longer accepts.",
        "    Convert them in a migration:",
        '      defineMigration("job-gate-code", Job).convertProperty("gateCode", ({ value }) => …)',
      ].join("\n")
    )
  })
})

describe("a change pending migrations cover", () => {
  const v2 = release([prop("hours", "string")], [link("crew", Technician)])
  const removeGate = defineMigration("job-gate", v2.Job).removeProperty("gate")

  test("runs a covered removal data holds, then records the code's shape", async () => {
    const storage = await deployed([create("J-1", { gate: "B12" }), create("J-2", { gate: "C3" })])

    const result = await deploy(storage, v2, [removeGate])
    expect(result.shapes?.types.find((type) => type.objectTypeId === "Job")?.run).toEqual([
      { migrationId: "job-gate", index: 0 },
    ])
    for (const primaryId of ["J-1", "J-2"]) {
      const job = await storage.objects.getByPrimaryId({
        projectId: PROJECT,
        objectTypeId: "Job",
        primaryId,
      })
      expect(job?.properties).not.toHaveProperty("gate")
    }
    expect((await storedJob(storage))?.shape.properties).not.toHaveProperty("gate")
  })

  // Guard removal: drop `count: false` from the runnable probe in `migrationFindings`.
  test("only asks whether data holds a change that runs: the run counts what it rewrites", async () => {
    const storage = await deployed([create("J-1", { gate: "B12" })])
    // In memory, `holds` counts too: only a count asked for outside it is one.
    const shapes = storage.ontology.typeShapes
    const counted: string[] = []
    const [holds, count] = [shapes.holds.bind(shapes), shapes.count.bind(shapes)]
    let probing = false
    shapes.holds = async (input) => {
      probing = true
      try {
        return await holds(input)
      } finally {
        probing = false
      }
    }
    shapes.count = (input) => {
      if (!probing) counted.push(JSON.stringify(input.probe))
      return count(input)
    }

    await deploy(storage, v2, [removeGate])
    expect(counted).toEqual([])
  })

  test("records the code's shape when no data holds it", async () => {
    const storage = await deployed([create("J-1", { hours: "3" })])
    await deploy(storage, v2, [removeGate])

    expect((await storedJob(storage))?.shape.properties).not.toHaveProperty("gate")
  })

  test("names every migration whose steps cover it", async () => {
    const optionalText = release([prop("hours", "string")])
    const storage = await deployed([create("J-1"), create("J-2", { hours: "3" })], optionalText)

    const requiredDouble = release([prop("hours", "double", { required: true })])
    const migrations = [
      defineMigration("job-hours-fill", requiredDouble.Job).fillProperty("hours", () => 0),
      defineMigration("job-hours-convert", requiredDouble.Job).convertProperty(
        "hours",
        ({ value }) => Number(value)
      ),
    ]

    expect(await messageOf(deploy(storage, requiredDouble, migrations))).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Job: 'hours' is now required, and 1 object lacks it: created without it or cleared by an edit.",
        "    Migration 'job-hours-fill' is pending; this build can't apply it yet.",
        "  ✗ Job: 'hours' changed from string to double, and 1 object holds edits it no longer accepts.",
        "    Migration 'job-hours-convert' is pending; this build can't apply it yet.",
      ].join("\n")
    )
  })

  // The first deploy's baseline holds only the keys data holds: a legacy key can be renamed.
  test("covers a rename on the first deploy, when no shape is recorded yet", async () => {
    const storage = new InMemoryStorage()
    await commit(storage, v1.ontology, [create("J-1", { gate: "B12" })])

    const v2 = release(
      [prop("gateCode", "string"), prop("hours", "string")],
      [link("crew", Technician)]
    )
    const migration = defineMigration("job-gate", v2.Job).renameProperty("gate", "gateCode")
    await deploy(storage, v2, [migration])

    expect((await storedJob(storage))?.shape.properties).toHaveProperty("gateCode")
    const job = await storage.objects.getByPrimaryId({
      projectId: PROJECT,
      objectTypeId: "Job",
      primaryId: "J-1",
    })
    expect(job?.properties).toEqual({ ref: "J-1", gateCode: "B12" })
  })

  // Guard proof: in `coverage.ts`, compare the changes' kinds as they are. The new property's
  // "added as required" is then covered and its "now required" missing: two findings that
  // contradict each other.
  test("a rename into a new required property leaves one finding: the objects that lack it", async () => {
    const storage = await deployed([create("J-1", { gate: "B12" }), create("J-2")])
    const v2 = release(
      [prop("gateCode", "string", { required: true }), prop("hours", "string")],
      [link("crew", Technician)]
    )
    const migration = defineMigration("job-gate", v2.Job).renameProperty("gate", "gateCode")

    expect(await messageOf(deploy(storage, v2, [migration]))).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Job: 'gateCode' is now required, and 1 object lacks it: created without it or cleared by an edit.",
        "    Fill it in a migration:",
        '      defineMigration("job-gate-code", Job).fillProperty("gateCode", ({ object }) => …)',
      ].join("\n")
    )
  })

  test("refuses two pending converts of one property, data or not", async () => {
    const storage = await deployed([])
    const double = release(
      [prop("gate", "string"), prop("hours", "double")],
      [link("crew", Technician)]
    )
    const migrations = [
      defineMigration("hours-old", double.Job).convertProperty("hours", () => 0),
      defineMigration("hours-new", double.Job).convertProperty("hours", () => 1),
    ]

    expect(await messageOf(deploy(storage, double, migrations))).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Job: migration 'hours-new' converts 'hours', and migration 'hours-old' converts 'hours': only one can run.",
        "    Keep one. A migration every database has applied can be deleted.",
      ].join("\n")
    )
  })

  test("covers a subtype through a migration of its parent", async () => {
    const withSubtypes = release([prop("gate", "string"), prop("hours", "string")], [], true)
    const storage = await deployed([create("I-1", { gate: "B12" }, "Inspection")], withSubtypes)

    const next = release([prop("hours", "string")], [], true)
    const migration = defineMigration("job-gate", next.Job).removeProperty("gate")
    const result = await deploy(storage, next, [migration])

    const planned = result.shapes?.types.filter((type) => type.run.length > 0)
    expect(planned?.map((type) => type.objectTypeId)).toEqual(["Inspection"])
    const inspection = await storage.objects.getByPrimaryId({
      projectId: PROJECT,
      objectTypeId: "Inspection",
      primaryId: "I-1",
    })
    expect(inspection?.properties).not.toHaveProperty("gate")
  })
})

describe("a migration settles once the code's shape is recorded", () => {
  // The enum narrows twice: `job-status` was written for the first narrowing, which this database
  // never had. A role recorded its first shapes before it knew the migrations; the next deploy
  // finds the code's shape recorded and settles them, so the old convert doesn't re-arm on the
  // second narrowing. Guard removal: in `recordTypeShapes`, settle only the types it writes.
  test("even when the stored shape already is the code's", async () => {
    const twoStatuses = release([prop("status", stringEnum(["open", "closed"]))])
    const lower = defineMigration("job-status", twoStatuses.Job).convertProperty(
      "status",
      () => "open"
    )

    const storage = new InMemoryStorage()
    await migrateStorage(storage, {
      projectId: PROJECT,
      ontology: twoStatuses.ontology,
      ontologyShapes: "role",
    })
    await commit(storage, twoStatuses.ontology, [create("J-1", { status: "closed" })])

    await deploy(storage, twoStatuses, [lower])
    const settled = await storage.ontology.migrations?.listSettled({ projectId: PROJECT })
    expect(settled?.map((row) => row.migrationId)).toEqual(["job-status"])

    const oneStatus = release([prop("status", stringEnum(["open"]))])
    const message = await messageOf(deploy(storage, oneStatus, [lower]))
    expect(message).toContain("Convert them in a migration:")
    expect(message).not.toContain("'job-status' is pending")
  })
})

describe("a role", () => {
  // Revert check: in `roleCheck`, drop the `previous` test: the role then keeps the recorded
  // `gate`, as the release before a deploy would, and serves before the migration ran.
  test("refuses code whose migrations are still pending, for `sixb db migrate` to run", async () => {
    const storage = await deployed([create("J-1", { gate: "B12" })])
    const v2 = release([prop("hours", "string")], [link("crew", Technician)])
    const removeGate = defineMigration("job-gate", v2.Job).removeProperty("gate")

    const started = migrateStorage(storage, {
      projectId: PROJECT,
      ontology: v2.ontology,
      migrations: [removeGate],
      ontologyShapes: "role",
    })
    expect(await messageOf(started)).toContain(
      "Job: 'gate' was removed since its shape was recorded."
    )
  })
})

describe("a migration run", () => {
  // Revert check: in the in-memory `startRun` and `finishRun`, record the replaced shape as
  // `previous`, as a deploy does: the release before the run then starts on the data it rewrote.
  test("leaves no release before it a role can start: the old code can't serve what it rewrote", async () => {
    const storage = await deployed([create("J-1", { gate: "B12" })])
    const v2 = release(
      [prop("hours", "string"), prop("memo", "string")],
      [link("crew", Technician)]
    )
    await deploy(storage, v2, [defineMigration("job-gate", v2.Job).removeProperty("gate")])
    expect((await storedJob(storage))?.previous).toBeNull()

    const started = migrateStorage(storage, {
      projectId: PROJECT,
      ontology: v1.ontology,
      ontologyShapes: "role",
    })
    expect(await messageOf(started)).toContain(
      "Job: 'memo' was removed since its shape was recorded."
    )
  })

  // Revert check: as above: the release before a rename then starts, keeps `gateCode` recorded,
  // records its own `gate` next to it, and fails every edit of an object the run renamed.
  test("leaves the release before a rename refused, as a role", async () => {
    const storage = await deployed([create("J-1", { gate: "B12" })])
    const v2 = release(
      [prop("gateCode", "string"), prop("hours", "string")],
      [link("crew", Technician)]
    )
    await deploy(storage, v2, [
      defineMigration("job-gate-code", v2.Job).renameProperty("gate", "gateCode"),
    ])

    const started = migrateStorage(storage, {
      projectId: PROJECT,
      ontology: v1.ontology,
      ontologyShapes: "role",
    })
    expect(await messageOf(started)).toContain(
      "Job: 'gateCode' was removed since its shape was recorded."
    )
  })

  describe("over values a failed deploy made unique", () => {
    const unique = release(
      [prop("gate", "string", { unique: true }), prop("hours", "string")],
      [link("crew", Technician)]
    )
    const v2 = release([prop("gate", "string", { unique: true })], [link("crew", Technician)])
    const removeHours = defineMigration("job-hours", v2.Job).removeProperty("hours")

    /** `J-1`'s `gate` built by a deploy that failed, then `J-2` written by the old release. */
    async function stale(): Promise<Storage> {
      const storage = await deployed([create("J-1", { gate: "B12", hours: "3" })])
      await prepareUniqueProperties({ storage, projectId: PROJECT, ontology: unique.ontology })
      await commit(storage, v1.ontology, [create("J-2", { gate: "C3" })])
      return storage
    }

    /** `storage`, killed as the run's `step` is called for the first time. */
    function killedAt(storage: Storage, step: "applyBatch" | "finishRun"): Storage {
      const migrations = storage.ontology.migrations!
      const killed: OntologyMigrationStorage = {
        parallelism: migrations.parallelism,
        getOpenRun: (input) => migrations.getOpenRun(input),
        listSettled: (input) => migrations.listSettled(input),
        settle: (input) => migrations.settle(input),
        startRun: (input) => migrations.startRun(input),
        async applyBatch(input) {
          if (step === "applyBatch") throw new Error("the process was killed")
          return migrations.applyBatch(input)
        },
        async finishRun(input) {
          await migrations.finishRun(input)
          throw new Error("the process was killed")
        },
      }
      const ontology = new Proxy(storage.ontology, {
        get: (target, key) => (key === "migrations" ? killed : Reflect.get(target, key)),
      })
      return new Proxy(storage, {
        get(target, key) {
          if (key === "ontology") return ontology
          const value = Reflect.get(target, key)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    }

    // Revert check: in `applyTypeShapes`, drop the `clearUniqueProperties` before the run: the
    // run records `gate` unique as it finishes, and the deploy that finishes it trusts the values
    // the failed deploy built, which lack `J-2`'s.
    for (const step of ["applyBatch", "finishRun"] as const) {
      test(`are built again when the process is killed in \`${step}\``, async () => {
        const storage = await stale()
        const killed = await deploy(killedAt(storage, step), v2, [removeHours]).catch(
          (error: unknown) => error
        )
        expect(String(killed)).toContain("the process was killed")

        await deploy(storage, v2, [removeHours])
        const holder = await storage.objects.getByUniqueValue({
          projectId: PROJECT,
          objectTypeId: "Job",
          propertyId: "gate",
          valueKey: "C3",
        })
        expect(holder?.primaryId).toBe("J-2")
      })
    }
  })
})
