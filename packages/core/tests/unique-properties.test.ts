import { describe, expect, test } from "bun:test"
import {
  defineAction,
  defineObjectType,
  defineValueType,
  link,
  OntologyRegistry,
  type Property,
  prop,
  ref,
  SixbHost,
  stringEnum,
  valueTypeRef,
} from "../src"
import { computeOntologyRevision } from "../src/materializer"
import { renderOntologyDocs } from "../src/ontology/docs-markdown"
import type { Schema } from "../src/ontology/types"
import { uniqueValueKey } from "../src/ontology/unique-values"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const id = prop("id", "string", { primary: true, required: true })

function personWith(property: Property) {
  return defineObjectType({ id: "Person", name: "Person", properties: [id, property] })
}

function register(...sources: ReturnType<typeof defineObjectType>[]) {
  return new OntologyRegistry({ sources })
}

describe("unique property definitions", () => {
  test("accepts schemas whose values compare as exact keys", () => {
    const Email = defineValueType({ id: "Email", name: "Email", schema: "string" })
    const schemas: Schema[] = [
      "string",
      "uuid",
      "integer",
      "date",
      "userRef",
      stringEnum(["a", "b"]),
      { type: "enum", valueType: "integer", values: [1, 2] },
      valueTypeRef(Email),
    ]

    for (const schema of schemas) {
      const Person = personWith(prop("key", schema, { unique: true }))
      expect(register(Person).resolveObjectType("Person").properties[1]).toMatchObject({
        unique: true,
      })
    }
  })

  test("rejects schemas whose values are not exact keys", () => {
    const Reading = defineValueType({ id: "Reading", name: "Reading", schema: "double" })
    const rejected: [Schema, string][] = [
      ["double", "double"],
      ["decimal", "decimal"],
      ["timestamp", "timestamp"],
      ["boolean", "boolean"],
      ["fileRef", "fileRef"],
      [{ type: "array", items: "string" }, "array"],
      [{ type: "map", keySchema: "string", valueSchema: "string" }, "map"],
      [{ type: "object", properties: { a: { schema: "string" } } }, "object"],
      [valueTypeRef(Reading), "value type 'Reading'"],
    ]

    for (const [schema, label] of rejected) {
      const Person = personWith(prop("key", schema, { unique: true }))
      expect(() => register(Person)).toThrow(
        `[Sixb] Unique property 'Person.key' cannot use ${label}. ` +
          "Unique values must be strings, uuids, integers, dates, enums or user references."
      )
    }
  })

  test("rejects unique primary, telemetry and link properties", () => {
    const Primary = defineObjectType({
      id: "Person",
      name: "Person",
      properties: [prop("id", "string", { primary: true, required: true, unique: true })],
    })
    expect(() => register(Primary)).toThrow(
      "[Sixb] Unique property 'Person.id' is primary, and primary properties are already unique."
    )

    const Telemetry = personWith(prop("badge", "string", { mode: "telemetry", unique: true }))
    expect(() => register(Telemetry)).toThrow(
      "[Sixb] Unique property 'Person.badge' cannot be a telemetry property."
    )

    const Team = defineObjectType({ id: "Team", name: "Team", properties: [id] })
    const Member = defineObjectType({
      id: "Member",
      name: "Member",
      properties: [id],
      links: [link("teams", Team, { properties: [prop("seat", "string", { unique: true })] })],
    })
    expect(() => register(Team, Member)).toThrow(
      "[Sixb] Link property 'Member.teams.seat' cannot be unique. Unique values are supported on object properties only."
    )
  })

  test("accepts unique user references with any nullability", () => {
    const Person = personWith(prop("user", ref.user(), { nullable: true, unique: true }))
    expect(() => register(Person)).not.toThrow()
  })
})

describe("unique value keys", () => {
  test("key every integer by its decimal form, beyond 2^53 too", () => {
    expect(uniqueValueKey("integer", 42)).toBe("42")
    expect(uniqueValueKey("integer", 2 ** 60)).toBe("1152921504606847000")
    expect(uniqueValueKey("integer", 1.5)).toBeNull()
  })

  test("key user references by id and strings exactly", () => {
    expect(uniqueValueKey("userRef", { type: "user", id: "usr_1" })).toBe("usr_1")
    expect(uniqueValueKey("string", "Ada")).toBe("Ada")
    expect(uniqueValueKey("string", null)).toBeNull()
  })
})

describe("unique properties in the ontology revision", () => {
  test("change the revision only where a property is unique", () => {
    const plain = register(personWith(prop("email", "string")))
    const unique = register(personWith(prop("email", "string", { unique: true })))

    // The revision this ontology had before properties could be unique.
    expect(computeOntologyRevision(plain)).toBe(
      "ee557642455ec5afb889f18d06dd0d44ce91b04a8f9ae64a56ffd1b2be0c4dfe"
    )
    expect(computeOntologyRevision(unique)).not.toBe(computeOntologyRevision(plain))
  })
})

test("ontology docs flag a unique property", () => {
  const Person = personWith(prop("email", "string", { unique: true }))
  const ontology = register(Person)

  const rendered = renderOntologyDocs({
    catalog: {
      docPathFor: (objectTypeId) => `${objectTypeId}.md`,
      notesFor: () => [],
      listDocs: () => [],
      listScripts: () => [],
      isWildcardLink: () => false,
    },
    objectTypes: ontology.listObjectTypes(),
    valueTypesById: ontology.getValueTypesById(),
    actionsFor: () => [],
  })

  expect(rendered.files[0]?.contents).toContain("| `email` | string (unique) |")
})

describe("a duplicate unique value at write boundaries", () => {
  const Person = defineObjectType({
    id: "Person",
    name: "Person",
    properties: [id, prop("email", "string", { unique: true })],
  })
  const rename = defineAction("takeEmail")
    .on(Person)
    .params({ email: { schema: "string", required: true } })
    .edits(({ objects, subject, params }) => {
      objects(Person).byId(subject.primaryId).update({ email: params.email })
    })

  function createSixb() {
    const host = new SixbHost({
      id: "unique-boundaries",
      ontology: [Person],
      actions: [rename],
      ...createTestRuntimeDeps(),
    })
    return createTestSixb(host)
  }

  const message = "[Sixb] Another 'Person' object already has this 'email'."

  test("an object write fails with object.unique_violation, naming no value nor holder", async () => {
    const sixb = createSixb()
    await sixb.objects(Person).upsert({ properties: { id: "ada", email: "ada@example.com" } })

    await expect(
      sixb.objects(Person).upsert({ properties: { id: "bob", email: "ada@example.com" } })
    ).rejects.toMatchObject({
      code: "object.unique_violation",
      message,
      retryable: false,
      details: { objectTypeId: "Person", propertyId: "email" },
    })
  })

  // Removal proof: make `itemError` in `materializer/edits/commit.ts` always return the
  // `validation` code; the item then fails as an uncoded `OntologyValidationError`.
  test("a continue-mode batch item fails with object.unique_violation", async () => {
    const sixb = createSixb()
    await sixb.objects(Person).upsert({ properties: { id: "ada", email: "ada@example.com" } })

    const [taken, free] = await sixb.objects.upsertBatch("Person", [
      { properties: { id: "bob", email: "ada@example.com" } },
      { properties: { id: "cleo", email: "cleo@example.com" } },
    ])

    expect(free?.ok).toBe(true)
    expect(taken?.ok ? null : taken?.error).toMatchObject({
      code: "object.unique_violation",
      message,
      details: { objectTypeId: "Person", propertyId: "email" },
    })
  })

  test("an Action run fails with object.unique_violation", async () => {
    const sixb = createSixb()
    await sixb.objects(Person).upsert({ properties: { id: "ada", email: "ada@example.com" } })
    await sixb.objects(Person).upsert({ properties: { id: "bob", email: "bob@example.com" } })

    const run = await sixb.objects(Person).requestAction({
      id: "bob",
      actionId: "takeEmail",
      params: { email: "ada@example.com" },
    })

    expect(run.status).toBe("failed")
    expect(run.error).toMatchObject({
      code: "object.unique_violation",
      message: "Another object already has this unique value. Property 'Person.email' is unique.",
      details: { actionId: "takeEmail", phase: "commit" },
    })
  })
})
