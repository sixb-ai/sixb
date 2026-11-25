import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  defineObjectType,
  InMemoryStorage,
  link,
  migrateStorage,
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
import { checkTypeShapes, recordTypeShapes } from "../src/storage/migrations/type-shapes"

const PROJECT = "type-shape-gate"

const Technician = defineObjectType({
  id: "GateTechnician",
  name: "Technician",
  properties: [prop("id", "string", { primary: true, required: true })],
})

/** `Job` as one release of the code defines it. */
function jobOntology(
  properties: readonly Property[],
  links: readonly ObjectLink[] = []
): OntologyRegistry {
  const Job = defineObjectType({
    id: "Job",
    name: "Job",
    properties: [prop("ref", "string", { primary: true, required: true }), ...properties],
    links: [...links],
  })
  return new OntologyRegistry({ sources: [Job, Technician] })
}

const withGate = jobOntology(
  [prop("gate", "string"), prop("hours", "string")],
  [link("crew", Technician)]
)
const withoutGate = jobOntology([prop("hours", "string")], [link("crew", Technician)])

afterEach(() => {
  // A spy left in place would hide a later test's warning.
  warn?.mockRestore()
  info?.mockRestore()
})
let warn: ReturnType<typeof spyOn> | undefined
let info: ReturnType<typeof spyOn> | undefined

function deploy(storage: Storage, ontology: OntologyRegistry) {
  return migrateStorage(storage, { projectId: PROJECT, ontology, ontologyShapes: "deploy" })
}

async function stored(storage: Storage) {
  return storage.ontology.typeShapes.list({ projectId: PROJECT })
}

async function storedJob(storage: Storage) {
  return (await stored(storage)).find((row) => row.objectTypeId === "Job")
}

function materializer(storage: Storage, ontology: OntologyRegistry) {
  return createOntologyMaterializer({
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
}

async function commit(
  storage: Storage,
  ontology: OntologyRegistry,
  operations: readonly OntologyEditOperation[]
) {
  await materializer(storage, ontology).edits.commit({
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
  properties: Readonly<Record<string, JsonValue>> = {}
): OntologyEditOperation {
  return {
    id: `create-${ref}`,
    kind: "object.create",
    ref: { objectTypeId: "Job", primaryId: ref },
    properties: { ref, ...properties },
  }
}

function technician(id: string): OntologyEditOperation {
  return {
    id: `tech-${id}`,
    kind: "object.create",
    ref: { objectTypeId: Technician.id, primaryId: id },
    properties: { id },
  }
}

function crew(job: string, tech: string): OntologyEditOperation {
  return {
    id: `crew-${job}-${tech}`,
    kind: "link.upsert",
    ref: {
      source: { objectTypeId: "Job", primaryId: job },
      linkId: "crew",
      target: { objectTypeId: Technician.id, primaryId: tech },
    },
  }
}

async function appendTemperature(storage: Storage, ontology: OntologyRegistry, job: string) {
  await materializer(storage, ontology).telemetry.append({
    source: { kind: "runtime", requestId: `reading-${job}` },
    points: [
      {
        series: { object: { objectTypeId: "Job", primaryId: job }, propertyId: "temperature" },
        value: 21.5,
        at: "2026-04-01T00:00:00.000Z",
      },
    ],
  })
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(TypeShapeMismatchError)
  return (error as Error).message
}

describe("a deploy", () => {
  test("records the code's shape of a fresh store", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)

    expect((await storedJob(storage))?.shape.properties).toEqual({
      gate: { schema: "string" },
      hours: { schema: "string" },
      ref: { primary: true, required: true, schema: "string" },
    })
  })

  test("records a compatible change and keeps serving", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    await commit(storage, withGate, [create("J-1", { gate: "B12" })])

    const wider = jobOntology(
      [prop("gate", "string"), prop("hours", "string"), prop("note", "string")],
      [link("crew", Technician)]
    )
    const check = await checkTypeShapes({
      storage,
      projectId: PROJECT,
      ontology: wider,
      mode: "check",
    })
    expect(check).toMatchObject({ blocked: false, narrows: false })

    await deploy(storage, wider)
    expect((await storedJob(storage))?.shape.properties.note).toEqual({ schema: "string" })
  })

  test("records a narrowing no data holds, and says the services stop for it", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    await commit(storage, withGate, [create("J-1", { hours: "3" })])

    const check = await checkTypeShapes({
      storage,
      projectId: PROJECT,
      ontology: withoutGate,
      mode: "check",
    })
    expect(check).toMatchObject({ blocked: false, narrows: true })

    await deploy(storage, withoutGate)
    expect((await storedJob(storage))?.shape.properties).not.toHaveProperty("gate")
  })

  // Removal proof: in `checkType`, pause writes only for the changes probes read; a property made
  // unique then records while the old release still writes values another object holds.
  test("pauses writes for a property made unique, which unique preparation checks", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    await commit(storage, withGate, [create("J-1", { gate: "B12" }), create("J-2", { gate: "C3" })])
    const unique = jobOntology(
      [prop("gate", "string", { unique: true }), prop("hours", "string")],
      [link("crew", Technician)]
    )

    const check = await checkTypeShapes({
      storage,
      projectId: PROJECT,
      ontology: unique,
      mode: "check",
    })
    expect(check).toMatchObject({ blocked: false, narrows: true })
    expect(check.types.find((type) => type.objectTypeId === "Job")?.findings).toEqual([])

    await deploy(storage, unique)
    expect((await storedJob(storage))?.shape.properties.gate).toMatchObject({ unique: true })
  })

  test("refuses a removed property objects hold, counts them, and records nothing", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    const jobs = Array.from({ length: 1_200 }, (_, index) => create(`J-${index}`, { gate: "B12" }))
    await commit(storage, withGate, jobs)
    const before = await storedJob(storage)

    const message = await messageOf(deploy(storage, withoutGate))
    expect(message).toBe(
      [
        "[Sixb] The stored objects don't fit this code:",
        "  ✗ Job: 'gate' was removed, and 1,200 objects hold it.",
        "    Declare it again until a migration removes it.",
      ].join("\n")
    )
    expect(await storedJob(storage)).toEqual(before)
  })

  test("refuses a required property objects created by actions lack", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    await commit(storage, withGate, [create("J-1", { gate: "B12" })])

    const required = jobOntology(
      [prop("gate", "string"), prop("hours", "string", { required: true })],
      [link("crew", Technician)]
    )
    expect(await messageOf(deploy(storage, required))).toContain(
      "✗ Job: 'hours' is now required, and 1 object lacks it: created without it or cleared by an edit."
    )
  })

  test("refuses a narrowed schema an edit's value no longer fits, by the framework's validator", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    await commit(storage, withGate, [
      create("J-1", { hours: "3" }),
      create("J-2", { hours: "three" }),
    ])

    const retyped = jobOntology(
      [prop("gate", "string"), prop("hours", "double")],
      [link("crew", Technician)]
    )
    expect(await messageOf(deploy(storage, retyped))).toContain(
      "✗ Job: 'hours' changed from string to double, and 2 objects hold edits it no longer accepts."
    )
  })

  test("refuses a removed link links hold", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    await commit(storage, withGate, [
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

    const unlinked = jobOntology([prop("gate", "string"), prop("hours", "string")])
    expect(await messageOf(deploy(storage, unlinked))).toContain(
      "✗ Job: link 'crew' was removed, and 1 object holds it."
    )
  })

  test("refuses a mode change data holds, and records one nothing holds", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    const series = jobOntology(
      [prop("gate", "string", { mode: "telemetry" }), prop("hours", "string")],
      [link("crew", Technician)]
    )
    await deploy(storage, series)
    expect((await storedJob(storage))?.shape.properties.gate).toEqual({
      mode: "telemetry",
      schema: "string",
    })

    await commit(storage, withGate, [create("J-1", { hours: "1" })])
    await deploy(storage, withGate)
    await commit(storage, withGate, [create("J-2", { gate: "B12" })])

    expect(await messageOf(deploy(storage, series))).toContain(
      "✗ Job: 'gate' became telemetry, and 1 object holds it.\n" +
        "    Changing a property's mode isn't supported yet: add a new property instead."
    )
  })

  test("drops the shape of a removed type that holds nothing, and refuses one that holds objects", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    const technicianOnly = new OntologyRegistry({ sources: [Technician] })

    await commit(storage, withGate, [create("J-1")])
    expect(await messageOf(deploy(storage, technicianOnly))).toContain(
      "✗ Job was removed, and 1 object holds it."
    )

    await commit(storage, withGate, [
      { id: "delete", kind: "object.delete", ref: { objectTypeId: "Job", primaryId: "J-1" } },
    ])
    // A delete over an object created by an action leaves no edit behind.
    await deploy(storage, technicianOnly)
    expect(await storedJob(storage)).toBeUndefined()
  })

  // Removal proof: in `migrateStorage`, move the ontology step after `prepareUniqueProperties`;
  // the values of `gate` are then dropped before the deploy is refused.
  test("is refused before unique values are rebuilt for the new shape", async () => {
    const storage = new InMemoryStorage()
    const unique = jobOntology([prop("gate", "string", { unique: true })])
    await deploy(storage, unique)
    await commit(storage, unique, [create("J-1", { gate: "B12" })])

    const renamed = jobOntology([prop("gateCode", "string", { unique: true })])
    await messageOf(deploy(storage, renamed))

    const prepared = await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })
    expect(prepared.map((property) => property.propertyId)).toEqual(["gate"])
  })
})

describe("a removed type", () => {
  // Revert check: in `checkType`, diff the stored shape itself, not `withoutRemovedTargets` of it:
  // the deploy is refused for `at`, which no longer targets `GateOffice`.
  test("leaves the links to its parent alone: its own removal probes its objects", async () => {
    const Space = defineObjectType({
      id: "GateSpace",
      name: "Space",
      properties: [prop("id", "string", { primary: true, required: true })],
    })
    const Room = defineObjectType({ ...Space, id: "GateRoom", name: "Room", extends: Space.id })
    const Office = defineObjectType({
      ...Space,
      id: "GateOffice",
      name: "Office",
      extends: Space.id,
    })
    const Visit = defineObjectType({
      id: "GateVisit",
      name: "Visit",
      properties: [prop("ref", "string", { primary: true, required: true })],
      links: [link("at", Space)],
    })
    const withOffice = new OntologyRegistry({ sources: [Space, Room, Office, Visit] })
    const withoutOffice = new OntologyRegistry({ sources: [Space, Room, Visit] })

    const storage = new InMemoryStorage()
    await deploy(storage, withOffice)
    await commit(storage, withOffice, [
      {
        id: "room",
        kind: "object.create",
        ref: { objectTypeId: Room.id, primaryId: "R-1" },
        properties: { id: "R-1" },
      },
      {
        id: "visit",
        kind: "object.create",
        ref: { objectTypeId: Visit.id, primaryId: "V-1" },
        properties: { ref: "V-1" },
      },
      {
        id: "at",
        kind: "link.upsert",
        ref: {
          source: { objectTypeId: Visit.id, primaryId: "V-1" },
          linkId: "at",
          target: { objectTypeId: Room.id, primaryId: "R-1" },
        },
      },
    ])

    await deploy(storage, withoutOffice)
    const visit = (await stored(storage)).find((row) => row.objectTypeId === Visit.id)
    expect(visit?.shape.links.at?.targets).toEqual([Room.id, Space.id])
  })
})

describe("the first deploy's validation pass", () => {
  test("records a key no definition declares as an unknown property, and refuses it", async () => {
    const storage = new InMemoryStorage()
    // An older release stored `gate` before shapes were recorded.
    await commit(storage, withGate, [create("J-1", { gate: "B12" })])

    const check = await checkTypeShapes({
      storage,
      projectId: PROJECT,
      ontology: withoutGate,
      mode: "check",
    })
    const job = check.types.find((type) => type.objectTypeId === "Job")!
    expect(job.baseline?.properties.gate).toEqual({ schema: "unknown", unknown: true })
    expect(job.findings.map((finding) => finding.message)).toEqual([
      "Job: 'gate' was removed, and 1 object holds it.",
    ])
  })

  test("records what failing data fits: an unknown schema, a required property it lacks as added", async () => {
    const storage = new InMemoryStorage()
    await commit(storage, withGate, [create("J-1", { hours: "three" })])

    const stricter = jobOntology(
      [prop("gate", "string", { required: true }), prop("hours", "double")],
      [link("crew", Technician)]
    )
    const check = await checkTypeShapes({
      storage,
      projectId: PROJECT,
      ontology: stricter,
      mode: "check",
    })
    const job = check.types.find((type) => type.objectTypeId === "Job")!

    expect(job.baseline?.properties.hours).toEqual({ schema: "unknown" })
    // Nothing holds `gate`: it reads as added by the code, as a required property.
    expect(job.baseline?.properties).not.toHaveProperty("gate")
    expect(job.findings.map((finding) => finding.message)).toEqual([
      "Job: 'gate' was added as required, and 1 object lacks it: created without it or cleared by an edit.",
      "Job: 'hours' changed from unknown to double, and 1 object holds edits it no longer accepts.",
    ])
  })

  // Removal proof: in `baselineShape`, start the properties from the code's; `gateCode` is then
  // in the baseline, and a rename from `gate` can never be pending.
  test("lists only what the data holds, so a renamed key reads as removed and added", async () => {
    const storage = new InMemoryStorage()
    await commit(storage, withGate, [create("J-1", { gate: "B12", hours: "3" })])

    const renamed = jobOntology(
      [prop("gateCode", "string"), prop("hours", "string"), prop("note", "string")],
      [link("crew", Technician)]
    )
    const check = await checkTypeShapes({
      storage,
      projectId: PROJECT,
      ontology: renamed,
      mode: "check",
    })
    const job = check.types.find((type) => type.objectTypeId === "Job")!

    expect(Object.keys(job.baseline?.properties ?? {})).toEqual(["gate", "hours", "ref"])
    expect(job.baseline?.links).toEqual({})
    expect(
      job.changes.map(
        (change) => `${change.kind}:${"propertyId" in change ? change.propertyId : ""}`
      )
    ).toEqual([
      "property-removed:gate",
      "property-added:gateCode",
      "property-added:note",
      "link-added:",
    ])
  })

  test("records a link and a telemetry series no definition declares, and refuses them", async () => {
    const storage = new InMemoryStorage()
    const series = jobOntology(
      [prop("temperature", "double", { mode: "telemetry" })],
      [link("crew", Technician)]
    )
    await commit(storage, series, [create("J-1"), technician("T-1"), crew("J-1", "T-1")])
    await appendTemperature(storage, series, "J-1")

    const bare = jobOntology([])
    const check = await checkTypeShapes({
      storage,
      projectId: PROJECT,
      ontology: bare,
      mode: "check",
    })
    const job = check.types.find((type) => type.objectTypeId === "Job")!

    expect(job.baseline?.links.crew).toEqual({ cardinality: "many", targets: [], unknown: true })
    expect(job.baseline?.properties.temperature).toEqual({
      mode: "telemetry",
      schema: "unknown",
      unknown: true,
    })
    expect(job.findings.map((finding) => finding.message)).toEqual([
      "Job: telemetry 'temperature' was removed, and 1 object holds it.",
      "Job: link 'crew' was removed, and 1 object holds it.",
    ])
  })

  // Removal proof: in `checkType`, drop `|| baseline !== undefined` from `pausesWrites`.
  test("stops the old release before recording a first shape over stored data", async () => {
    const storage = new InMemoryStorage()
    await commit(storage, withGate, [create("J-1", { gate: "B12", hours: "3" })])

    const check = await checkTypeShapes({
      storage,
      projectId: PROJECT,
      ontology: withGate,
      mode: "check",
    })
    expect(check).toMatchObject({ blocked: false, narrows: true })
  })

  test("records the code's shape when the data fits it", async () => {
    const storage = new InMemoryStorage()
    await commit(storage, withGate, [create("J-1", { gate: "B12", hours: "3" })])

    await deploy(storage, withGate)
    expect((await storedJob(storage))?.shape.properties.gate).toEqual({ schema: "string" })
  })
})

describe("a role", () => {
  function startRole(storage: Storage, ontology: OntologyRegistry) {
    return migrateStorage(storage, { projectId: PROJECT, ontology, ontologyShapes: "role" })
  }

  test("refuses a property made unique: `sixb db migrate` builds its values", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    const unique = jobOntology(
      [prop("gate", "string", { unique: true }), prop("hours", "string")],
      [link("crew", Technician)]
    )

    expect(await messageOf(startRole(storage, unique))).toContain("Job: 'gate' is now unique")
  })

  test("records a compatible change", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withoutGate)

    await startRole(storage, withGate)
    expect((await storedJob(storage))?.shape.properties.gate).toEqual({ schema: "string" })
  })

  test("refuses code that narrows a type, without reading its data", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)

    expect(await messageOf(startRole(storage, withoutGate))).toBe(
      [
        "[Sixb] The code changed object types since their shape was recorded, and the stored objects may not fit:",
        "  ✗ Job: 'gate' was removed since its shape was recorded.",
        "Run `sixb db migrate` first: it checks the stored objects and records the new shapes.",
      ].join("\n")
    )
  })

  // Removal proof: in `nextWrite`, drop the `keep` for a stored shape equal to the code's.
  test("takes no lock when the recorded shapes are the code's", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    const transaction = spyOn(storage, "transaction")

    await startRole(storage, withGate)
    expect(transaction).not.toHaveBeenCalled()
    transaction.mockRestore()
  })

  test("records a new type that holds nothing, and leaves one holding objects to `db migrate`", async () => {
    const storage = new InMemoryStorage()
    await commit(storage, withGate, [create("J-1", { gate: "B12" })])
    info = spyOn(console, "info").mockImplementation(() => {})

    const result = await startRole(storage, withGate)
    expect(result.shapes?.unrecorded).toEqual(["Job"])
    expect((await stored(storage)).map((row) => row.objectTypeId)).toEqual([Technician.id])
    expect(info).toHaveBeenCalledWith(
      "[Sixb] 'Job' has objects and no recorded shape yet: `sixb db migrate` records it."
    )
  })
})

describe("`sixb dev`", () => {
  function dev(storage: Storage, ontology: OntologyRegistry) {
    return migrateStorage(storage, { projectId: PROJECT, ontology, ontologyShapes: "dev" })
  }

  test("warns about data the code doesn't fit and keeps the recorded shape", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    await commit(storage, withGate, [create("J-1", { gate: "B12" })])
    const before = await storedJob(storage)
    warn = spyOn(console, "warn").mockImplementation(() => {})

    await dev(storage, withoutGate)
    expect(await storedJob(storage)).toEqual(before)
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "✗ Job: 'gate' was removed, and 1 object holds it."
    )
  })

  test("records what the data fits on a first run, so a migration added later applies to it", async () => {
    const storage = new InMemoryStorage()
    await commit(storage, withGate, [create("J-1", { gate: "B12" })])
    warn = spyOn(console, "warn").mockImplementation(() => {})

    await dev(storage, withoutGate)
    expect((await storedJob(storage))?.shape.properties.gate).toEqual({
      schema: "unknown",
      unknown: true,
    })
  })

  // Removal proof: in `migrateStorage`, pass no `keepObjectTypeIds`; the values of `gate` are
  // then dropped, or, skipping the preparation whole, `Technician.badge` is never prepared.
  test("keeps the unique values of a type the code doesn't fit, and prepares the others", async () => {
    const storage = new InMemoryStorage()
    const unique = jobOntology([prop("gate", "string", { unique: true })])
    await deploy(storage, unique)
    await commit(storage, unique, [create("J-1", { gate: "B12" })])
    warn = spyOn(console, "warn").mockImplementation(() => {})

    const BadgedTechnician = defineObjectType({
      id: Technician.id,
      name: "Technician",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("badge", "string", { unique: true }),
      ],
    })
    const Job = defineObjectType({
      id: "Job",
      name: "Job",
      properties: [
        prop("ref", "string", { primary: true, required: true }),
        prop("gateCode", "string", { unique: true }),
      ],
    })
    await dev(storage, new OntologyRegistry({ sources: [Job, BadgedTechnician] }))

    const prepared = await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })
    const ids = prepared.map((property) => `${property.objectTypeId}.${property.propertyId}`)
    expect(ids.sort()).toEqual([`${Technician.id}.badge`, "Job.gate"].sort())
  })

  test("records a narrowing no data holds", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)

    await dev(storage, withoutGate)
    expect((await storedJob(storage))?.shape.properties).not.toHaveProperty("gate")
  })
})

describe("recording", () => {
  test("writes nothing in check mode", async () => {
    const storage = new InMemoryStorage()
    await migrateStorage(storage, {
      projectId: PROJECT,
      ontology: withGate,
      ontologyShapes: "check",
    })
    expect(await stored(storage)).toEqual([])
  })

  test("fails when a shape changed since it was checked, unless it already holds the new one", async () => {
    const storage = new InMemoryStorage()
    await deploy(storage, withGate)
    const check = await checkTypeShapes({
      storage,
      projectId: PROJECT,
      ontology: withoutGate,
      mode: "deploy",
    })

    // Another role recorded the same shape meanwhile: nothing left to do.
    await deploy(storage, withoutGate)
    await recordTypeShapes(storage, check)

    // Another deploy recorded a different one: the check is stale.
    const wider = jobOntology(
      [prop("hours", "string"), prop("note", "string")],
      [link("crew", Technician)]
    )
    await deploy(storage, wider)
    const stale = await recordTypeShapes(storage, check).catch((error: unknown) => error)
    expect(String(stale)).toContain("The stored shape of 'Job' changed while it was being checked.")
  })
})

describe("unique values and a deploy that fails", () => {
  /** `Alpha.code`, `Job.note` and `Other.tag`; `Other.tag` is always unique. */
  function release(unique: boolean) {
    const options = unique ? { unique: true as const } : {}
    const Alpha = defineObjectType({
      id: "Alpha",
      name: "Alpha",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("code", "string", options),
      ],
    })
    const Job = defineObjectType({
      id: "Job",
      name: "Job",
      properties: [
        prop("ref", "string", { primary: true, required: true }),
        prop("note", "string", options),
      ],
    })
    const Other = defineObjectType({
      id: "Other",
      name: "Other",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("tag", "string", { unique: true }),
      ],
    })
    return new OntologyRegistry({ sources: [Alpha, Job, Other] })
  }
  const before = release(false)
  const after = release(true)

  function upsert(objectTypeId: string, primaryId: string, properties: Record<string, JsonValue>) {
    const primary = objectTypeId === "Job" ? "ref" : "id"
    return {
      id: `upsert-${objectTypeId}-${primaryId}-${crypto.randomUUID()}`,
      kind: "object.upsert",
      ref: { objectTypeId, primaryId },
      properties: { [primary]: primaryId, ...properties },
    } as OntologyEditOperation
  }

  async function holder(storage: Storage, objectTypeId: string, propertyId: string, value: string) {
    const held = await storage.objects.getByUniqueValue({
      projectId: PROJECT,
      objectTypeId,
      propertyId,
      valueKey: value,
    })
    return held?.primaryId ?? null
  }

  /** A deploy of `after` that fails on `Job.note`, which two jobs share, over prepared `Other.tag`. */
  async function failedDeploy(): Promise<Storage> {
    const storage = new InMemoryStorage()
    await deploy(storage, before)
    await commit(storage, before, [
      upsert("Alpha", "A-1", { code: "X" }),
      upsert("Job", "J-1", { note: "same" }),
      upsert("Job", "J-2", { note: "same" }),
      upsert("Other", "O-1", { tag: "t" }),
    ])
    const prepared = await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })

    // `sixb check --migrate` writes no preparation before its own probes, nor does a deploy that
    // a duplicate stops: `Alpha.code`, which comes first and has none, isn't prepared either.
    await migrateStorage(storage, { projectId: PROJECT, ontology: after, ontologyShapes: "check" })
    expect(await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })).toEqual(
      prepared
    )

    const failed = await deploy(storage, after).catch((error: unknown) => error)
    expect(String(failed)).toContain("Cannot make 'Job.note' unique")
    expect(await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })).toEqual(
      prepared
    )
    return storage
  }

  // Removal proof: drop `checkUniqueProperties` from `applyTypeShapes`; `Alpha.code` is then
  // prepared before `Job.note` fails, and stays.
  test("prepares nothing, for any type, when a duplicate stops it", async () => {
    await failedDeploy()
  })

  // Removal proof: as above; the next deploy then trusts `Alpha.code`'s stale value `X`.
  test("leaves the old release's writes for the next deploy to build from", async () => {
    const storage = await failedDeploy()

    // The old release starts again, and writes what it doesn't keep unique.
    await commit(storage, before, [
      upsert("Alpha", "A-1", { code: "Y" }),
      upsert("Job", "J-2", { note: "other" }),
    ])
    await deploy(storage, after)

    expect(await holder(storage, "Alpha", "code", "Y")).toBe("A-1")
    expect(await holder(storage, "Alpha", "code", "X")).toBeNull()
    expect(await holder(storage, "Job", "note", "same")).toBe("J-1")
  })
})
