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

// The deploy's gate with the project's migrations: a change their pending steps cover isn't
// missing one, one they don't says what to write, and this build, which can't run migrations yet,
// still stops on covered data. The pending algorithm alone is in `ontology-migrations-pending`.

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

  // Until a build can run migrations, covered data still stops the deploy, and says why.
  test("stops the deploy while data holds it, naming the migration", async () => {
    const storage = await deployed([create("J-1", { gate: "B12" }), create("J-2", { gate: "C3" })])
    const before = await storedJob(storage)

    expect(await messageOf(deploy(storage, v2, [removeGate]))).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Job: 'gate' was removed, and 2 objects hold it.",
        "    Migration 'job-gate' is pending; this build can't apply it yet.",
      ].join("\n")
    )
    expect(await storedJob(storage)).toEqual(before)
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
    expect(await messageOf(deploy(storage, v2, [migration]))).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Job: 'gate' was removed, and 1 object holds it.",
        "    Migration 'job-gate' is pending; this build can't apply it yet.",
      ].join("\n")
    )
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
        "  ✗ Job: 'gate' was removed, and 1 object holds it.",
        "    Migration 'job-gate' is pending; this build can't apply it yet.",
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
    expect(await messageOf(deploy(storage, next, [migration]))).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Inspection: 'gate' was removed, and 1 object holds it.",
        "    Migration 'job-gate' is pending; this build can't apply it yet.",
      ].join("\n")
    )
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
