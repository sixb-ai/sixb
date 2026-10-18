import { describe, expect, test } from "bun:test"
import type { FileRef } from "../src"
import {
  defineObjectType,
  defineValueType,
  link,
  OntologyRegistry,
  OntologyValidationError,
  prop,
  stringEnum,
} from "../src"
import type {
  ObjectTypeSearchMetadata,
  Property,
  PropertyQueryMetadata,
  Schema,
  ValueType,
} from "../src/ontology"
import {
  assertKnownProperties,
  assertRequiredProperties,
  assertTelemetryProperty,
  resolveSemanticType,
  validateLinkProperties,
  validatePropertyValue,
  validateSchemaValue,
  validateTelemetryUnit,
} from "../src/ontology/validation"

const emptyMap = new Map<string, ValueType>()
const validFileRef: FileRef = {
  blobId: "blob_abc",
  digest: "sha256:abc",
  sizeBytes: 42,
  fileName: "invoice.pdf",
  mediaType: "application/pdf",
}

const temperatureValueTypes = new Map<string, ValueType>([
  [
    "Temperature",
    defineValueType({
      id: "Temperature",
      name: "Temperature",
      schema: "double",
      semanticType: "Temperature",
    }),
  ],
])
const stringEnumSchema = {
  type: "enum" as const,
  valueType: "string" as const,
  values: ["a", "b", "c"],
}
const stringMapSchema = {
  type: "map" as const,
  keySchema: "string" as const,
  valueSchema: "string" as const,
}
const integerMapSchema = { ...stringMapSchema, valueSchema: "integer" as const }
const personSchema = {
  type: "object" as const,
  properties: {
    name: { schema: "string" as const, required: true },
    age: { schema: "integer" as const, required: false },
    label: { schema: "string" as const, required: false, nullable: true },
    nickname: { schema: "string" as const, required: false, nullable: false },
  },
}
const temperatureRef = { type: "valueTypeRef" as const, valueTypeId: "Temperature" }

function expectValidationError(run: () => unknown, message: string): void {
  let error: unknown
  try {
    run()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(OntologyValidationError)
  expect(String(error)).toContain(message)
}

describe("validateSchemaValue", () => {
  test.each<[string, Schema, unknown]>([
    ["string", "string", "hello"],
    ["boolean", "boolean", true],
    ["integer", "integer", 5],
    ["double", "double", 3.14],
    ["exact decimal string", "decimal", "99.99"],
    ["Date object", "date", new Date("2026-01-01T00:00:00.000Z")],
    ["ISO date string", "date", "2026-01-01"],
    ["timestamp string", "timestamp", "2026-01-01T00:00:00Z"],
    ["uuid string", "uuid", "abc-123"],
    ["fileRef", "fileRef", validFileRef],
    ["enum member", stringEnumSchema, "b"],
    ["array of valid items", { type: "array", items: "string" }, ["a", "b"]],
    ["object map", stringMapSchema, { a: "x", b: "y" }],
    ["object without optional fields", personSchema, { name: "Alice" }],
    ["null on a nullable object field", personSchema, { name: "Alice", label: null }],
    ["value of a valueTypeRef's schema", temperatureRef, 22.5],
  ])("accepts a %s", (_, schema, value) => {
    expect(() => validateSchemaValue(schema, value, "test", temperatureValueTypes)).not.toThrow()
  })

  test.each<[string, Schema, unknown, string]>([
    ["a non-string", "string", 42, "must be a string"],
    ["a non-boolean", "boolean", "yes", "must be a boolean"],
    ["a float as integer", "integer", 3.14, "must be an integer"],
    ["NaN", "double", Number.NaN, "must be numeric"],
    ["a number as decimal", "decimal", 99.99, "must be an exact decimal string"],
    ["a number as date", "date", 12345, "must be a Date or ISO string"],
    ["an invalid fileRef", "fileRef", { blobId: "missing" }, "must be a fileRef"],
    ["a non-member enum value", stringEnumSchema, "d", "must be one of: a, b, c"],
    ["a non-array", { type: "array", items: "string" }, "not-array", "must be an array"],
    [
      "an invalid array item",
      { type: "array", items: "integer" },
      [1, "two"],
      "must be an integer",
    ],
    ["a non-object map", stringMapSchema, "not-obj", "must be an object map"],
    ["an array as map", stringMapSchema, ["a"], "must be an object map"],
    ["an invalid map value", integerMapSchema, { a: "nope" }, "must be an integer"],
    ["a missing required object field", personSchema, {}, "Missing required field"],
    ["an unknown object field", personSchema, { name: "A", extra: true }, "Unknown field"],
    [
      "null on a non-nullable object field",
      personSchema,
      { name: "A", nickname: null },
      "cannot be null",
    ],
    ["a value outside a valueTypeRef's schema", temperatureRef, "hot", "must be numeric"],
    [
      "an unknown valueTypeRef",
      { type: "valueTypeRef", valueTypeId: "Unknown" },
      1,
      "Unknown valueTypeRef",
    ],
  ])("rejects %s", (_, schema, value, message) => {
    expectValidationError(
      () => validateSchemaValue(schema, value, "test", temperatureValueTypes),
      message
    )
  })
})

describe("property validation", () => {
  const nameProperty: Property = {
    id: "name",
    name: "Name",
    schema: "string",
    required: true,
    mode: "static",
  }
  const objectType = defineObjectType({
    id: "TestType",
    name: "Test",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("name", "string", { required: true }),
      prop("description", "string"),
    ],
  })

  test("accepts null on a nullable property and known, complete property sets", () => {
    expect(() =>
      validatePropertyValue({ ...nameProperty, nullable: true }, null, "test.name", emptyMap)
    ).not.toThrow()
    expect(() => assertKnownProperties(objectType, { id: "t-1", name: "hello" })).not.toThrow()
    expect(() => assertRequiredProperties(objectType, { id: "t-1", name: "hello" })).not.toThrow()
  })

  test.each<[string, () => unknown, string]>([
    [
      "an undefined property value",
      () => validatePropertyValue(nameProperty, undefined, "test.name", emptyMap),
      "cannot be undefined",
    ],
    [
      "null on a non-nullable property",
      () => validatePropertyValue(nameProperty, null, "test.name", emptyMap),
      "cannot be null",
    ],
    [
      "a property value outside its schema",
      () => validatePropertyValue(nameProperty, 42, "test.name", emptyMap),
      "must be a string",
    ],
    [
      "an unknown property",
      () => assertKnownProperties(objectType, { unknown: "value" }),
      "Unknown property 'unknown'",
    ],
    [
      "a missing required property",
      () => assertRequiredProperties(objectType, {}),
      "Missing required property 'id'",
    ],
  ])("rejects %s", (_, run, message) => {
    expectValidationError(run, message)
  })
})

describe("ontology startup validation", () => {
  test.each([
    {
      name: "valid query and search metadata",
      objectType: defineObjectType({
        id: "Customer",
        name: "Customer",
        properties: [
          prop("id", "string", { required: true, primary: true }),
          prop("name", "string", {
            required: true,
            query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
          }),
          prop("email", "string", { query: { searchable: true, text: true, exact: true } }),
          prop("status", stringEnum(["active", "paused"]), {
            query: { searchable: true, filterable: true, exact: true, facet: true },
          }),
          prop(
            "tags",
            { type: "array", items: "string" },
            { query: { searchable: true, filterable: true } }
          ),
          prop(
            "metadata",
            { type: "map", keySchema: "string", valueSchema: "string" },
            { query: { searchable: true, filterable: true } }
          ),
          prop("embedding", { type: "array", items: "double" }, { query: { searchable: true } }),
        ],
        search: { title: "name", defaultText: ["name", "email"], exact: ["id", "email"] },
      }),
    },
    {
      name: "the primary id in an exact search profile without exact metadata",
      objectType: defineObjectType({
        id: "PrimaryExactProfile",
        name: "Primary Exact Profile",
        properties: [
          prop("id", "string", { required: true, primary: true }),
          prop("name", "string", { query: { searchable: true, text: true } }),
        ],
        search: { title: "name", defaultText: ["name"], exact: ["id"] },
      }),
    },
  ])("accepts $name", ({ objectType }) => {
    expect(() => new OntologyRegistry({ sources: [objectType] })).not.toThrow()
  })

  // The vector rows are runtime (untyped JS) guards: removing them makes those rows fail.
  test.each([
    {
      name: "a primary fileRef property",
      properties: [prop("id", "fileRef", { required: true, primary: true })],
      message: 'must have schema "string"',
    },
    {
      name: "a telemetry fileRef property",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("document", "fileRef", { mode: "telemetry" }),
      ],
      message: "cannot use fileRef",
    },
    {
      name: "query features that do not opt in with searchable",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { query: { text: true } }),
      ],
      message: "must set query.searchable: true",
    },
    {
      name: "text search on a non-string-like property",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("amount", "double", { query: { searchable: true, text: true } }),
      ],
      message: "schema is not string-like",
    },
    {
      name: "search profile fields without matching property query flags",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
      search: { title: "name", defaultText: ["name"] },
      message: "must set query.searchable: true and query.text: true",
    },
    {
      name: "telemetry properties in search profiles",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("currentStatus", "string", {
          mode: "telemetry",
          query: { searchable: true, text: true },
        }),
      ],
      search: { title: "currentStatus", defaultText: ["currentStatus"] },
      message: "can only reference static properties",
    },
    {
      name: "removed vector property metadata",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop(
          "embedding",
          { type: "array", items: "double" },
          { query: { searchable: true, vector: true } as PropertyQueryMetadata }
        ),
      ],
      message: "removed query.vector",
    },
    {
      name: "removed singular vector search metadata",
      properties: [prop("id", "string", { primary: true, required: true })],
      search: { vector: { property: "embedding", source: ["id"] } } as ObjectTypeSearchMetadata,
      message: "removed search.vector",
    },
  ] satisfies {
    name: string
    properties: Property[]
    search?: ObjectTypeSearchMetadata
    message: string
  }[])("rejects $name", ({ properties, search, message }) => {
    const objectType = defineObjectType({
      id: "Invalid",
      name: "Invalid",
      properties,
      ...(search ? { search } : {}),
    })
    expectValidationError(() => new OntologyRegistry({ sources: [objectType] }), message)
  })
})

describe("validateLinkProperties", () => {
  const objectType = defineObjectType({
    id: "Room",
    name: "Room",
    properties: [prop("id", "string", { required: true, primary: true })],
    links: [
      link.ref("hasDevice", "Device", {
        properties: [prop("installedBy", "string", { required: true }), prop("notes", "string")],
      }),
      link.ref("hasNeighbor", "Room"),
    ],
  })
  const deviceLink = objectType.links[0]
  const neighborLink = objectType.links[1]

  test("accepts valid properties and checks required ones against the merged state", () => {
    expect(() =>
      validateLinkProperties(objectType, deviceLink, { installedBy: "tech-a" }, undefined, emptyMap)
    ).not.toThrow()
    expect(() =>
      validateLinkProperties(
        objectType,
        deviceLink,
        { notes: "test" },
        { installedBy: "tech-a" },
        emptyMap
      )
    ).not.toThrow()
  })

  test.each<[string, () => unknown, string]>([
    [
      "properties on a link that defines none",
      () => validateLinkProperties(objectType, neighborLink, { foo: "bar" }, undefined, emptyMap),
      "does not define link properties",
    ],
    [
      "an unknown link property",
      () => validateLinkProperties(objectType, deviceLink, { unknown: "val" }, undefined, emptyMap),
      "Unknown link property 'unknown'",
    ],
    [
      "a required link property missing from the merged state",
      () => validateLinkProperties(objectType, deviceLink, { notes: "test" }, undefined, emptyMap),
      "Missing required link property 'installedBy'",
    ],
  ])("rejects %s", (_, run, message) => {
    expectValidationError(run, message)
  })
})

describe("telemetry validation", () => {
  const temperature: Property = {
    id: "temp",
    name: "Temp",
    schema: "double",
    required: false,
    mode: "telemetry",
    semanticType: "Temperature",
  }
  const count: Property = {
    id: "count",
    name: "Count",
    schema: "integer",
    required: false,
    mode: "telemetry",
  }

  test("accepts telemetry properties with a unit of their semantic type", () => {
    expect(() => assertTelemetryProperty(temperature)).not.toThrow()
    expect(() =>
      validateTelemetryUnit(temperature, "test.temp", "degreeCelsius", emptyMap)
    ).not.toThrow()
  })

  test.each<[string, () => unknown, string]>([
    [
      "a static property",
      () => assertTelemetryProperty({ ...temperature, mode: "static" }),
      "not telemetry-enabled",
    ],
    [
      "a missing unit when a semantic type is set",
      () => validateTelemetryUnit(temperature, "test.temp", undefined, emptyMap),
      "Missing unit",
    ],
    [
      "a unit of another quantity",
      () => validateTelemetryUnit(temperature, "test.temp", "millibar", emptyMap),
      "Invalid unit",
    ],
    [
      "a unit without a semantic type",
      () => validateTelemetryUnit(count, "test.count", "degreeCelsius", emptyMap),
      "does not define semanticType",
    ],
  ])("rejects %s", (_, run, message) => {
    expectValidationError(run, message)
  })

  test("resolveSemanticType follows a valueTypeRef, or finds none", () => {
    const viaRef: Property = { ...count, schema: temperatureRef }
    expect(resolveSemanticType(viaRef, temperatureValueTypes)).toBe("Temperature")
    expect(resolveSemanticType(count, emptyMap)).toBeUndefined()
  })
})
