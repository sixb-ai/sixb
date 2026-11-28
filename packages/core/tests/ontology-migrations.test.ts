import { describe, expect, test } from "bun:test"
import {
  defineMigration,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type MigrationDefinition,
  OntologyRegistry,
  prop,
  SixbHost,
} from "../src"
import { inertMigrations, validateMigrationsAtStartup } from "../src/migrations/validation"

// What `defineMigration` builds, what `sixb check` refuses at load without storage, and which
// migrations the code has moved past.

const Job = defineObjectType({
  id: "Job",
  name: "Job",
  properties: [
    prop("ref", "string", { primary: true, required: true }),
    prop("gateCode", "string"),
    prop("hours", "double", { required: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
})
const Inspection = defineObjectType({
  id: "Inspection",
  name: "Inspection",
  extends: Job,
  properties: [prop("inspector", "string")],
})
const ontology = new OntologyRegistry({ sources: [Job, Inspection] })

function validate(...migrations: MigrationDefinition[]) {
  return validateMigrationsAtStartup({ migrations, ontology })
}

function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("Expected the migration to be refused.")
}

describe("defineMigration", () => {
  test("each call returns a new definition, with its steps as plain data", () => {
    const base = defineMigration("job-gate", Job)
    const migration = base
      .renameProperty("gate", "gateCode")
      .removeProperty("legacyNote")
      .removeLink("oldCrew")

    expect(base.steps).toEqual([])
    expect(Object.keys(migration).sort()).toEqual(["id", "kind", "objectTypeId", "steps"])
    expect(migration).toMatchObject({ kind: "migration", id: "job-gate", objectTypeId: "Job" })
    expect(migration.steps).toEqual([
      { kind: "renameProperty", from: "gate", to: "gateCode" },
      { kind: "removeProperty", propertyId: "legacyNote" },
      { kind: "removeLink", linkId: "oldCrew" },
    ])
    expect(Object.isFrozen(migration)).toBe(true)
  })

  test("keeps each value step's function", () => {
    const fill = () => 0
    const migration = defineMigration("job-hours", Job)
      .fillProperty("hours", fill)
      .convertProperty("hours", ({ value }) => Number(value))

    expect(migration.steps[0]).toEqual({ kind: "fillProperty", propertyId: "hours", fill })
    expect(migration.steps[1]?.kind).toBe("convertProperty")
  })

  test("refuses an empty id or a missing type at once", () => {
    expect(() => defineMigration("", Job)).toThrow(
      "[Sixb] Migration id must be a non-empty string."
    )
    expect(() => defineMigration("x", null as never)).toThrow(
      "[Sixb] Migration 'x' needs an object type."
    )
    expect(() => defineMigration("x", Job).removeProperty("")).toThrow(
      "[Sixb] Migration 'x', removeProperty: ids must be non-empty strings."
    )
  })
})

describe("refused at load: a migration that can never be right", () => {
  test("accepts steps that match the code", () => {
    const migration = defineMigration("job", Job)
      .renameProperty("gate", "gateCode")
      .removeProperty("legacyNote")
      .fillProperty("hours", () => 0)
      .convertProperty("hours", ({ value }) => Number(value))

    expect([...validate(migration).keys()]).toEqual(["job"])
  })

  test.each([
    [
      "a migration with no step",
      () => defineMigration("job", Job),
      "[Sixb] Migration 'job' has no steps: add at least one.",
    ],
    [
      "a rename into itself",
      () => defineMigration("job", Job).renameProperty("gateCode", "gateCode"),
      "[Sixb] Migration 'job' renames 'gateCode' to itself.",
    ],
    [
      "a fill of the primary property",
      () => defineMigration("job", Job).fillProperty("ref", () => "x"),
      "[Sixb] Migration 'job' fills 'ref', the primary property of Job: changing it isn't supported yet.",
    ],
    [
      "a rename into a telemetry property",
      () => defineMigration("job", Job).renameProperty("temp", "temperature"),
      "[Sixb] Migration 'job' renames 'temp' to 'temperature', a telemetry property: migrating telemetry isn't supported yet.",
    ],
    [
      "a convert of a telemetry property",
      () => defineMigration("job", Job).convertProperty("temperature", () => 0),
      "[Sixb] Migration 'job' converts 'temperature', a telemetry property: migrating telemetry isn't supported yet.",
    ],
    [
      "two converts of one property",
      () =>
        defineMigration("job", Job)
          .convertProperty("hours", () => 0)
          .convertProperty("hours", () => 1),
      "[Sixb] Migration 'job' converts 'hours' twice: keep one step.",
    ],
    [
      "a rename and a removal of one property",
      () => defineMigration("job", Job).renameProperty("gate", "gateCode").removeProperty("gate"),
      "[Sixb] Migration 'job' renames 'gate' to 'gateCode' and removes 'gate': a property changes once per migration.",
    ],
  ] as const)("refuses %s", (_case, migration, message) => {
    expect(messageOf(() => validate(migration()))).toBe(message)
  })

  test("refuses two migrations with one id", () => {
    const one = defineMigration("job", Job).removeProperty("a")
    const two = defineMigration("job", Job).removeProperty("b")
    expect(messageOf(() => validate(one, two))).toBe(
      "[Sixb] Two migrations have the id 'job': give each its own."
    )
  })

  test("a host refuses to load one, as `sixb check` does", () => {
    const load = () =>
      new SixbHost({
        ontology: [Job],
        migrations: [defineMigration("job", Job).fillProperty("ref", () => "x")],
        storage: new InMemoryStorage(),
        broker: new InMemoryBroker(),
        queues: new InMemoryQueues(),
        lakeStorage: new InMemoryLakeStorage(),
        blobStorage: new InMemoryBlobStorage(),
      })

    expect(load).toThrow("[Sixb] Migration 'job' fills 'ref', the primary property of Job")
  })
})

describe("a migration the code has moved past", () => {
  const Other = defineObjectType({
    id: "Other",
    name: "Other",
    properties: [prop("id", "string", { primary: true, required: true })],
  })
  const stale = [
    defineMigration("job-hours-removed", Job).removeProperty("hours"),
    defineMigration("job-inherited", Inspection).removeProperty("gateCode"),
    defineMigration("job-gate-renamed", Job).renameProperty("gate", "gateId" as "gateCode"),
    defineMigration("job-gate-back", Job).renameProperty("gateCode", "hours"),
    defineMigration("job-note-filled", Job).fillProperty("note" as "hours", () => 0),
    defineMigration("other-gone", Other).removeProperty("legacy"),
  ]

  test("loads: only `sixb check` says it can go", () => {
    expect([...validate(...stale).keys()]).toHaveLength(stale.length)
    expect(inertMigrations({ migrations: stale, ontology })).toEqual([
      "Migration 'job-hours-removed' removes 'hours', which Job declares again: it does nothing now, and can be deleted once every database has applied it.",
      "Migration 'job-inherited' removes 'gateCode', which Inspection declares again: it does nothing now, and can be deleted once every database has applied it.",
      "Migration 'job-gate-renamed' renames 'gate' to 'gateId', which Job no longer declares: it does nothing now, and can be deleted once every database has applied it.",
      "Migration 'job-gate-back' renames 'gateCode', which Job declares again: it does nothing now, and can be deleted once every database has applied it.",
      "Migration 'job-note-filled' fills 'note', which Job no longer declares: it does nothing now, and can be deleted once every database has applied it.",
      "Migration 'other-gone' is for 'Other', no longer defined: it does nothing now, and can be deleted once every database has applied it.",
    ])
  })

  test("is quiet while one of its steps still applies", () => {
    const partly = defineMigration("job-partly", Job)
      .removeProperty("hours")
      .removeProperty("legacyNote")
    expect(inertMigrations({ migrations: [partly], ontology })).toEqual([])
  })
})
