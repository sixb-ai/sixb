import { describe, expect, test } from "bun:test"
import {
  defineMigration,
  defineObjectType,
  link,
  OntologyRegistry,
  type Property,
  prop,
} from "../src"
import { planPendingSteps } from "../src/migrations/pending"
import type { MigrationDefinition } from "../src/migrations/types"
import { type TypeShape, typeShape } from "../src/ontology/type-shapes"
import type { ObjectLink } from "../src/ontology/types"

// Pending by shape, with no storage: which steps the stored shape still needs, in what order, and
// which pairs can't both run. The gate's use of it is in `ontology-migrations-gate.test.ts`.

const Technician = defineObjectType({
  id: "Technician",
  name: "Technician",
  properties: [prop("id", "string", { primary: true, required: true })],
})

/** `Job` as one release of the code defines it, and the ontology around it. */
function release(properties: readonly Property[], links: readonly ObjectLink[] = []) {
  const Job = defineObjectType({
    id: "Job",
    name: "Job",
    properties: [prop("ref", "string", { primary: true, required: true }), ...properties],
    links: [...links],
  })
  const ontology = new OntologyRegistry({ sources: [Job, Technician] })
  return { Job, ontology, shape: typeShape(ontology.resolveObjectType("Job"), ontology) }
}

const v1 = release(
  [prop("gate", "string"), prop("hours", "string"), prop("note", "string")],
  [link("crew", Technician)]
)

function plan(
  stored: TypeShape,
  code: { readonly ontology: OntologyRegistry },
  migrations: readonly MigrationDefinition[],
  objectTypeId = "Job"
) {
  return planPendingSteps({ objectTypeId, stored, ontology: code.ontology, migrations })
}

/** `migration:index kind` for each step that runs, in order. */
function order(pending: ReturnType<typeof plan>): string[] {
  return pending.steps.map(
    (planned) => `${planned.migrationId}:${planned.index} ${planned.step.kind}`
  )
}

describe("a step is pending while the stored shape needs it", () => {
  test("removeProperty: while the stored shape still has the property", () => {
    const v2 = release(
      [prop("hours", "string"), prop("note", "string")],
      [link("crew", Technician)]
    )
    const migration = defineMigration("job-gate", v2.Job).removeProperty("gate")

    expect(order(plan(v1.shape, v2, [migration]))).toEqual(["job-gate:0 removeProperty"])
    expect(order(plan(v2.shape, v2, [migration]))).toEqual([])
  })

  test("removeLink: while the stored shape still has the link", () => {
    const v2 = release([prop("gate", "string"), prop("hours", "string"), prop("note", "string")])
    const migration = defineMigration("job-crew", v2.Job).removeLink("crew")

    expect(order(plan(v1.shape, v2, [migration]))).toEqual(["job-crew:0 removeLink"])
    expect(order(plan(v2.shape, v2, [migration]))).toEqual([])
  })

  test("renameProperty: while the stored shape has `from` and not `to`", () => {
    const v2 = release(
      [prop("gateCode", "string"), prop("hours", "string"), prop("note", "string")],
      [link("crew", Technician)]
    )
    const migration = defineMigration("job-gate", v2.Job).renameProperty("gate", "gateCode")

    const pending = plan(v1.shape, v2, [migration])
    expect(order(pending)).toEqual(["job-gate:0 renameProperty"])
    expect(pending.shape).toEqual(v2.shape)
    expect(pending.storedKey("gateCode")).toBe("gate")
    expect(pending.storedKey("hours")).toBe("hours")

    expect(order(plan(v2.shape, v2, [migration]))).toEqual([])
  })

  test("fillProperty: while the code requires the property and the stored shape doesn't", () => {
    const v2 = release(
      [prop("gate", "string"), prop("hours", "string"), prop("note", "string", { required: true })],
      [link("crew", Technician)]
    )
    const migration = defineMigration("job-note", v2.Job).fillProperty("note", () => "none")

    expect(order(plan(v1.shape, v2, [migration]))).toEqual(["job-note:0 fillProperty"])
    expect(order(plan(v2.shape, v2, [migration]))).toEqual([])
  })

  test("convertProperty: while the stored schema is one the code's doesn't widen", () => {
    const v2 = release(
      [prop("gate", "string"), prop("hours", "double"), prop("note", "string")],
      [link("crew", Technician)]
    )
    const migration = defineMigration("job-hours", v2.Job).convertProperty("hours", ({ value }) =>
      Number(value)
    )

    expect(order(plan(v1.shape, v2, [migration]))).toEqual(["job-hours:0 convertProperty"])
    expect(order(plan(v2.shape, v2, [migration]))).toEqual([])
  })

  // A convert kept in the repo must not rewrite values again when the property later widens.
  // Guard proof: make `convertProperty.pending` compare schemas for equality, and this fails.
  test("convertProperty: never for a widening", () => {
    const integer = release([prop("hours", "integer")])
    const double = release([prop("hours", "double")])
    const migration = defineMigration("job-hours", double.Job).convertProperty("hours", () => 1)

    expect(order(plan(integer.shape, double, [migration]))).toEqual([])
  })

  test("a new database's baseline is the code's shape: no migration ever runs there", () => {
    const v2 = release(
      [prop("gateCode", "string"), prop("hours", "double", { required: true })],
      [link("crew", Technician)]
    )
    const migrations = [
      defineMigration("job-gate", v2.Job)
        .renameProperty("gate", "gateCode")
        .removeProperty("note")
        .fillProperty("hours", () => 0)
        .convertProperty("hours", ({ value }) => Number(value)),
    ]

    const pending = plan(v2.shape, v2, migrations)
    expect(pending.steps).toEqual([])
    expect(pending.conflicts).toEqual([])
  })
})

describe("the order steps run in", () => {
  // The migration ids sort the convert first: the order comes from the conditions alone.
  test("renames into a property before converting it", () => {
    const v2 = release([prop("gateCode", "integer")])
    const migrations = [
      defineMigration("a-convert", v2.Job).convertProperty("gateCode", ({ value }) =>
        Number(value)
      ),
      defineMigration("b-rename", v2.Job).renameProperty("gate", "gateCode"),
    ]

    const pending = plan(release([prop("gate", "string")]).shape, v2, migrations)
    expect(order(pending)).toEqual(["b-rename:0 renameProperty", "a-convert:0 convertProperty"])
    expect(pending.shape).toEqual(v2.shape)
  })

  test("renames into a property before filling the objects that lack it", () => {
    const v2 = release([prop("gateCode", "string", { required: true })])
    const migrations = [
      defineMigration("a-fill", v2.Job).fillProperty("gateCode", () => "none"),
      defineMigration("b-rename", v2.Job).renameProperty("gate", "gateCode"),
    ]

    // Both are pending from the start: a fill first would take `gateCode` and block the rename.
    // Renames run before values. Guard proof: in `planPendingSteps`, run `pending[0]` instead,
    // and the rename is blocked.
    const pending = plan(release([prop("gate", "string")]).shape, v2, migrations)
    expect(order(pending)).toEqual(["b-rename:0 renameProperty", "a-fill:0 fillProperty"])
    expect(pending.shape).toEqual(v2.shape)
  })

  // Guard proof: give `removeProperty` phase 0, as key moves had before values, and the removal
  // runs first: the fill would read an `assignedTo` already gone.
  test("fills from a property before removing it, whatever the migrations' ids", () => {
    const v2 = release([prop("crewLead", "string", { required: true })])
    const stored = release([prop("assignedTo", "string")]).shape
    const fill = ({ object }: { readonly object: Readonly<Record<string, unknown>> }) =>
      String(object.assignedTo)

    const one = defineMigration("job-crew-lead", v2.Job)
      .fillProperty("crewLead", fill)
      .removeProperty("assignedTo")
    expect(order(plan(stored, v2, [one]))).toEqual([
      "job-crew-lead:0 fillProperty",
      "job-crew-lead:1 removeProperty",
    ])

    const two = [
      defineMigration("a-remove", v2.Job).removeProperty("assignedTo"),
      defineMigration("b-fill", v2.Job).fillProperty("crewLead", fill),
    ]
    expect(order(plan(stored, v2, two))).toEqual([
      "b-fill:0 fillProperty",
      "a-remove:0 removeProperty",
    ])
  })

  test("runs steps of different migrations on different properties of one type: branches compose", () => {
    const v2 = release([prop("hours", "string")])
    const migrations = [
      // One branch removed `note`, another `gate`; merged, both are pending.
      defineMigration("job-note", v2.Job).removeProperty("note"),
      defineMigration("job-gate", v2.Job).removeProperty("gate"),
    ]

    const pending = plan(v1.shape, v2, migrations)
    expect(order(pending)).toEqual(["job-gate:0 removeProperty", "job-note:0 removeProperty"])
    expect(pending.conflicts).toEqual([])
  })

  test("explains a rename the stored shape keeps from running", () => {
    // The stored objects already hold both: `gateCode` can't take `gate`'s values.
    const stored = release([prop("gate", "string"), prop("gateCode", "string")]).shape
    const v2 = release([prop("gateCode", "string")])
    const migration = defineMigration("job-gate", v2.Job).renameProperty("gate", "gateCode")

    const pending = plan(stored, v2, [migration])
    expect(pending.steps).toEqual([])
    expect(pending.blocked.map((blocked) => [blocked.migrationId, blocked.reason])).toEqual([
      ["job-gate", "the stored Job already has 'gateCode'."],
    ])
  })
})

describe("steps that can't both run", () => {
  const optionalText = release([prop("hours", "string")])
  const requiredDouble = release([prop("hours", "double", { required: true })])

  test("one fill and one convert of a property run together", () => {
    const migrations = [
      defineMigration("job-hours-fill", requiredDouble.Job).fillProperty("hours", () => 0),
      defineMigration("job-hours-convert", requiredDouble.Job).convertProperty(
        "hours",
        ({ value }) => Number(value)
      ),
    ]

    const pending = plan(optionalText.shape, requiredDouble, migrations)
    expect(pending.conflicts).toEqual([])
    expect(order(pending)).toEqual([
      "job-hours-convert:0 convertProperty",
      "job-hours-fill:0 fillProperty",
    ])
    expect(pending.shape).toEqual(requiredDouble.shape)
  })

  test("two converts of a property are refused", () => {
    const double = release([prop("hours", "double")])
    const migrations = [
      defineMigration("hours-old", double.Job).convertProperty("hours", ({ value }) =>
        Number(value)
      ),
      defineMigration("hours-new", double.Job).convertProperty("hours", () => 0),
    ]

    const pending = plan(optionalText.shape, double, migrations)
    expect(pending.steps).toEqual([])
    expect(pending.conflicts.map((conflict) => conflict.message)).toEqual([
      "Job: migration 'hours-new' converts 'hours', and migration 'hours-old' converts 'hours': only one can run.",
    ])
  })

  test("two fills of a property are refused", () => {
    const required = release([prop("hours", "string", { required: true })])
    const migrations = [
      defineMigration("hours-a", required.Job).fillProperty("hours", () => "0"),
      defineMigration("hours-b", required.Job).fillProperty("hours", () => "1"),
    ]

    expect(plan(optionalText.shape, required, migrations).conflicts).toHaveLength(1)
  })

  test("a removal and a rename of one property are refused", () => {
    const v2 = release([prop("gateCode", "string")])
    const migrations = [
      defineMigration("job-gate-remove", release([]).Job).removeProperty("gate"),
      defineMigration("job-gate-rename", v2.Job).renameProperty("gate", "gateCode"),
    ]

    const pending = plan(release([prop("gate", "string")]).shape, v2, migrations)
    expect(pending.conflicts.map((conflict) => conflict.message)).toEqual([
      "Job: migration 'job-gate-remove' removes 'gate', and migration 'job-gate-rename' renames 'gate' to 'gateCode': only one can run.",
    ])
  })

  // Guard proof: drop the `sameKeyStep` check in `conflictsAmong`, and two branches that both
  // removed `gate` conflict.
  test("the same removal in two migrations runs once", () => {
    const v2 = release([])
    const migrations = [
      defineMigration("branch-a", v2.Job).removeProperty("gate"),
      defineMigration("branch-b", v2.Job).removeProperty("gate"),
    ]

    const pending = plan(release([prop("gate", "string")]).shape, v2, migrations)
    expect(pending.conflicts).toEqual([])
    expect(order(pending)).toEqual(["branch-a:0 removeProperty"])
  })
})

describe("a migration runs at most once per database", () => {
  // An enum narrowed twice: the first convert ran when `c` went; its condition holds again when
  // `b` goes. Settled, it stays out, and the new narrowing needs its own migration.
  // Guard proof: drop the `settled` filter in `planPendingSteps`, and the old convert re-arms.
  test("a settled migration is never pending again, though its conditions hold", () => {
    const enumOf = (...values: string[]) =>
      release([prop("status", { type: "enum", valueType: "string", values })])
    const stored = enumOf("a", "b").shape
    const code = enumOf("a")
    const old = defineMigration("job-status-c", code.Job).convertProperty("status", () => "a")

    expect(order(plan(stored, code, [old]))).toEqual(["job-status-c:0 convertProperty"])

    const settled = planPendingSteps({
      objectTypeId: "Job",
      stored,
      ontology: code.ontology,
      migrations: [old],
      settled: new Set(["job-status-c"]),
    })
    expect(settled.steps).toEqual([])
    expect(settled.shape).toEqual(stored)
  })
})

describe("subtypes", () => {
  const Job = defineObjectType({
    id: "Job",
    name: "Job",
    properties: [prop("ref", "string", { primary: true, required: true }), prop("hours", "double")],
  })
  const Inspection = defineObjectType({
    id: "Inspection",
    name: "Inspection",
    extends: Job,
    properties: [],
  })
  const Audit = defineObjectType({
    id: "Audit",
    name: "Audit",
    extends: Job,
    // Declared again, as whole hours: a convert of Job's `hours` to a double isn't Audit's.
    properties: [prop("hours", "integer"), prop("gate", "string")],
  })
  const ontology = new OntologyRegistry({ sources: [Job, Inspection, Audit] })
  const code = { Job, ontology, shape: typeShape(Job, ontology) }

  const stored = (objectTypeId: string): TypeShape => {
    const shape = typeShape(ontology.resolveObjectType(objectTypeId), ontology)
    return {
      ...shape,
      properties: { ...shape.properties, hours: { schema: "string" }, gate: { schema: "string" } },
    }
  }

  test("a migration of a type applies to each subtype that inherits what it touches", () => {
    const migrations = [
      defineMigration("job-hours", Job)
        .convertProperty("hours", ({ value }) => Number(value))
        .removeProperty("gate"),
    ]

    expect(order(plan(stored("Job"), code, migrations, "Job"))).toEqual([
      "job-hours:0 convertProperty",
      "job-hours:1 removeProperty",
    ])
    expect(order(plan(stored("Inspection"), code, migrations, "Inspection"))).toEqual([
      "job-hours:0 convertProperty",
      "job-hours:1 removeProperty",
    ])
    // Audit declares both again: neither step is its, though its stored `hours` narrowed too.
    // Guard proof: make `sameProperty` ignore the shapes, and the convert runs on Audit.
    expect(order(plan(stored("Audit"), code, migrations, "Audit"))).toEqual([])
  })

  test("a migration of a subtype leaves its parent alone", () => {
    const migrations = [
      defineMigration("inspection-hours", Inspection).convertProperty("hours", () => 0),
    ]

    expect(order(plan(stored("Job"), code, migrations, "Job"))).toEqual([])
    expect(order(plan(stored("Inspection"), code, migrations, "Inspection"))).toEqual([
      "inspection-hours:0 convertProperty",
    ])
  })
})
