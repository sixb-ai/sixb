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
import type { Property, ValueType } from "../src/ontology"
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

describe("validateSchemaValue", () => {
  test("string schema accepts strings", () => {
    expect(() => validateSchemaValue("string", "hello", "test", emptyMap)).not.toThrow()
  })

  test("string schema rejects non-strings", () => {
    expect(() => validateSchemaValue("string", 42, "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue("string", 42, "test", emptyMap)).toThrow("must be a string")
  })

  test("boolean schema accepts booleans", () => {
    expect(() => validateSchemaValue("boolean", true, "test", emptyMap)).not.toThrow()
  })

  test("boolean schema rejects non-booleans", () => {
    expect(() => validateSchemaValue("boolean", "yes", "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue("boolean", "yes", "test", emptyMap)).toThrow(
      "must be a boolean"
    )
  })

  test("integer schema accepts integers", () => {
    expect(() => validateSchemaValue("integer", 5, "test", emptyMap)).not.toThrow()
  })

  test("integer schema rejects floats", () => {
    expect(() => validateSchemaValue("integer", 3.14, "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue("integer", 3.14, "test", emptyMap)).toThrow(
      "must be an integer"
    )
  })

  test("double schema accepts numbers", () => {
    expect(() => validateSchemaValue("double", 3.14, "test", emptyMap)).not.toThrow()
  })

  test("double schema rejects NaN", () => {
    expect(() => validateSchemaValue("double", NaN, "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue("double", NaN, "test", emptyMap)).toThrow("must be numeric")
  })

  test("decimal schema accepts exact strings and rejects numbers", () => {
    expect(() => validateSchemaValue("decimal", "99.99", "test", emptyMap)).not.toThrow()
    expect(() => validateSchemaValue("decimal", 99.99, "test", emptyMap)).toThrow(
      "must be an exact decimal string"
    )
  })

  test("date schema accepts Date objects", () => {
    expect(() => validateSchemaValue("date", new Date(), "test", emptyMap)).not.toThrow()
  })

  test("date schema accepts ISO strings", () => {
    expect(() => validateSchemaValue("date", "2026-01-01", "test", emptyMap)).not.toThrow()
  })

  test("date schema rejects numbers", () => {
    expect(() => validateSchemaValue("date", 12345, "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue("date", 12345, "test", emptyMap)).toThrow(
      "must be a Date or ISO string"
    )
  })

  test("timestamp schema accepts strings", () => {
    expect(() =>
      validateSchemaValue("timestamp", "2026-01-01T00:00:00Z", "test", emptyMap)
    ).not.toThrow()
  })

  test("uuid schema accepts strings", () => {
    expect(() => validateSchemaValue("uuid", "abc-123", "test", emptyMap)).not.toThrow()
  })

  test("fileRef schema accepts valid file refs", () => {
    expect(() => validateSchemaValue("fileRef", validFileRef, "test", emptyMap)).not.toThrow()
  })

  test("fileRef schema rejects invalid refs", () => {
    expect(() => validateSchemaValue("fileRef", { blobId: "missing" }, "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue("fileRef", { blobId: "missing" }, "test", emptyMap)).toThrow(
      "must be a fileRef"
    )
  })

  test("enum schema accepts valid values", () => {
    const schema = { type: "enum" as const, valueType: "string" as const, values: ["a", "b", "c"] }
    expect(() => validateSchemaValue(schema, "b", "test", emptyMap)).not.toThrow()
  })

  test("enum schema rejects invalid values", () => {
    const schema = { type: "enum" as const, valueType: "string" as const, values: ["a", "b", "c"] }
    expect(() => validateSchemaValue(schema, "d", "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue(schema, "d", "test", emptyMap)).toThrow(
      "must be one of: a, b, c"
    )
  })

  test("array schema accepts arrays with valid items", () => {
    const schema = { type: "array" as const, items: "string" as const }
    expect(() => validateSchemaValue(schema, ["a", "b"], "test", emptyMap)).not.toThrow()
  })

  test("array schema rejects non-arrays", () => {
    const schema = { type: "array" as const, items: "string" as const }
    expect(() => validateSchemaValue(schema, "not-array", "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue(schema, "not-array", "test", emptyMap)).toThrow(
      "must be an array"
    )
  })

  test("array schema validates item types", () => {
    const schema = { type: "array" as const, items: "integer" as const }
    expect(() => validateSchemaValue(schema, [1, "two"], "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue(schema, [1, "two"], "test", emptyMap)).toThrow(
      "must be an integer"
    )
  })

  test("map schema accepts valid object maps", () => {
    const schema = {
      type: "map" as const,
      keySchema: "string" as const,
      valueSchema: "string" as const,
    }
    expect(() => validateSchemaValue(schema, { a: "x", b: "y" }, "test", emptyMap)).not.toThrow()
  })

  test("map schema rejects non-objects", () => {
    const schema = {
      type: "map" as const,
      keySchema: "string" as const,
      valueSchema: "string" as const,
    }
    expect(() => validateSchemaValue(schema, "not-obj", "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue(schema, "not-obj", "test", emptyMap)).toThrow(
      "must be an object map"
    )
  })

  test("map schema rejects arrays as maps", () => {
    const schema = {
      type: "map" as const,
      keySchema: "string" as const,
      valueSchema: "string" as const,
    }
    expect(() => validateSchemaValue(schema, ["a"], "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue(schema, ["a"], "test", emptyMap)).toThrow(
      "must be an object map"
    )
  })

  test("map schema validates value types", () => {
    const schema = {
      type: "map" as const,
      keySchema: "string" as const,
      valueSchema: "integer" as const,
    }
    expect(() => validateSchemaValue(schema, { a: "nope" }, "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue(schema, { a: "nope" }, "test", emptyMap)).toThrow(
      "must be an integer"
    )
  })

  test("object schema accepts valid objects", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { schema: "string" as const, required: true },
        age: { schema: "integer" as const, required: false },
      },
    }
    expect(() => validateSchemaValue(schema, { name: "Alice" }, "test", emptyMap)).not.toThrow()
  })

  test("object schema rejects missing required fields", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { schema: "string" as const, required: true },
      },
    }
    expect(() => validateSchemaValue(schema, {}, "test", emptyMap)).toThrow(OntologyValidationError)
    expect(() => validateSchemaValue(schema, {}, "test", emptyMap)).toThrow(
      "Missing required field"
    )
  })

  test("object schema rejects unknown fields", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { schema: "string" as const, required: false },
      },
    }
    expect(() => validateSchemaValue(schema, { name: "A", extra: true }, "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue(schema, { name: "A", extra: true }, "test", emptyMap)).toThrow(
      "Unknown field"
    )
  })

  test("object schema supports nullable fields", () => {
    const schema = {
      type: "object" as const,
      properties: {
        label: { schema: "string" as const, required: false, nullable: true },
      },
    }
    expect(() => validateSchemaValue(schema, { label: null }, "test", emptyMap)).not.toThrow()
  })

  test("object schema rejects null on non-nullable fields", () => {
    const schema = {
      type: "object" as const,
      properties: {
        label: { schema: "string" as const, required: false, nullable: false },
      },
    }
    expect(() => validateSchemaValue(schema, { label: null }, "test", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateSchemaValue(schema, { label: null }, "test", emptyMap)).toThrow(
      "cannot be null"
    )
  })

  test("valueTypeRef resolves and validates against value type schema", () => {
    const temperatureType = defineValueType({
      id: "Temperature",
      name: "Temperature",
      schema: "double",
      semanticType: "Temperature",
    })

    const vtMap = new Map<string, ValueType>([["Temperature", temperatureType]])
    const schema = { type: "valueTypeRef" as const, valueTypeId: "Temperature" }

    expect(() => validateSchemaValue(schema, 22.5, "test", vtMap)).not.toThrow()
    expect(() => validateSchemaValue(schema, "hot", "test", vtMap)).toThrow(OntologyValidationError)
    expect(() => validateSchemaValue(schema, "hot", "test", vtMap)).toThrow("must be numeric")
  })

  test("valueTypeRef throws for unknown value type", () => {
    const schema = { type: "valueTypeRef" as const, valueTypeId: "Unknown" }
    expect(() => validateSchemaValue(schema, 1, "test", emptyMap)).toThrow(OntologyValidationError)
    expect(() => validateSchemaValue(schema, 1, "test", emptyMap)).toThrow("Unknown valueTypeRef")
  })
})

describe("validatePropertyValue", () => {
  const stringProp: Property = {
    id: "name",
    name: "Name",
    schema: "string",
    required: true,
    mode: "static",
  }

  test("rejects undefined", () => {
    expect(() => validatePropertyValue(stringProp, undefined, "test.name", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validatePropertyValue(stringProp, undefined, "test.name", emptyMap)).toThrow(
      "cannot be undefined"
    )
  })

  test("accepts null for nullable properties", () => {
    const nullableProp: Property = { ...stringProp, nullable: true }
    expect(() => validatePropertyValue(nullableProp, null, "test.name", emptyMap)).not.toThrow()
  })

  test("rejects null for non-nullable properties", () => {
    expect(() => validatePropertyValue(stringProp, null, "test.name", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validatePropertyValue(stringProp, null, "test.name", emptyMap)).toThrow(
      "cannot be null"
    )
  })

  test("validates value against schema", () => {
    expect(() => validatePropertyValue(stringProp, 42, "test.name", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validatePropertyValue(stringProp, 42, "test.name", emptyMap)).toThrow(
      "must be a string"
    )
  })
})

describe("assertKnownProperties", () => {
  const objectType = defineObjectType({
    id: "TestType",
    name: "Test",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("name", "string", { required: true }),
    ],
  })

  test("accepts known properties", () => {
    expect(() => assertKnownProperties(objectType, { id: "t-1", name: "hello" })).not.toThrow()
  })

  test("rejects unknown properties", () => {
    expect(() => assertKnownProperties(objectType, { unknown: "value" })).toThrow(
      OntologyValidationError
    )
    expect(() => assertKnownProperties(objectType, { unknown: "value" })).toThrow(
      "Unknown property 'unknown'"
    )
  })
})

describe("assertRequiredProperties", () => {
  const objectType = defineObjectType({
    id: "TestType",
    name: "Test",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("name", "string", { required: true }),
      prop("description", "string"),
    ],
  })

  test("passes when required properties are present", () => {
    expect(() => assertRequiredProperties(objectType, { id: "t-1", name: "hello" })).not.toThrow()
  })

  test("fails when required properties are missing", () => {
    expect(() => assertRequiredProperties(objectType, {})).toThrow(OntologyValidationError)
    expect(() => assertRequiredProperties(objectType, {})).toThrow("Missing required property 'id'")
  })
})

describe("ontology startup validation", () => {
  test("rejects primary fileRef properties", () => {
    const objectType = defineObjectType({
      id: "FilePrimary",
      name: "File Primary",
      properties: [prop("id", "fileRef", { required: true, primary: true })],
    })

    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(OntologyValidationError)
    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(
      'must have schema "string"'
    )
  })

  test("rejects telemetry fileRef properties", () => {
    const objectType = defineObjectType({
      id: "TelemetryFile",
      name: "Telemetry File",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("document", "fileRef", { mode: "telemetry" }),
      ],
    })

    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(OntologyValidationError)
    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow("cannot use fileRef")
  })

  test("accepts valid query and search metadata", () => {
    const objectType = defineObjectType({
      id: "Customer",
      name: "Customer",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", {
          required: true,
          query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
        }),
        prop("email", "string", {
          query: { searchable: true, text: true, exact: true },
        }),
        prop("status", stringEnum(["active", "paused"]), {
          query: { searchable: true, filterable: true, exact: true, facet: true },
        }),
        prop(
          "tags",
          { type: "array", items: "string" },
          {
            query: { searchable: true, filterable: true },
          }
        ),
        prop(
          "metadata",
          { type: "map", keySchema: "string", valueSchema: "string" },
          {
            query: { searchable: true, filterable: true },
          }
        ),
        prop(
          "embedding",
          { type: "array", items: "double" },
          {
            query: { searchable: true, vector: true },
          }
        ),
      ],
      search: {
        title: "name",
        defaultText: ["name", "email"],
        exact: ["id", "email"],
        vector: { property: "embedding", source: ["name", "email"] },
      },
    })

    expect(() => new OntologyRegistry({ sources: [objectType] })).not.toThrow()
  })

  test("allows primary id in exact search profile without explicit exact metadata", () => {
    const objectType = defineObjectType({
      id: "PrimaryExactProfile",
      name: "Primary Exact Profile",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { query: { searchable: true, text: true } }),
      ],
      search: {
        title: "name",
        defaultText: ["name"],
        exact: ["id"],
      },
    })

    expect(() => new OntologyRegistry({ sources: [objectType] })).not.toThrow()
  })

  test("rejects query features that do not opt in with searchable", () => {
    const objectType = defineObjectType({
      id: "BadQuery",
      name: "Bad Query",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { query: { text: true } }),
      ],
    })

    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(OntologyValidationError)
    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(
      "must set query.searchable: true"
    )
  })

  test("rejects text search on non-string-like properties", () => {
    const objectType = defineObjectType({
      id: "BadText",
      name: "Bad Text",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("amount", "double", { query: { searchable: true, text: true } }),
      ],
    })

    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(OntologyValidationError)
    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(
      "schema is not string-like"
    )
  })

  test("rejects search profile fields without matching property query flags", () => {
    const objectType = defineObjectType({
      id: "BadSearchProfile",
      name: "Bad Search Profile",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
      search: { title: "name", defaultText: ["name"] },
    })

    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(OntologyValidationError)
    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(
      "must set query.searchable: true and query.text: true"
    )
  })

  test("rejects telemetry properties in search profiles", () => {
    const objectType = defineObjectType({
      id: "BadTelemetrySearch",
      name: "Bad Telemetry Search",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("currentStatus", "string", {
          mode: "telemetry",
          query: { searchable: true, text: true },
        }),
      ],
      search: { title: "currentStatus", defaultText: ["currentStatus"] },
    })

    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(OntologyValidationError)
    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(
      "can only reference static properties"
    )
  })

  test("rejects vector search properties that are not numeric arrays", () => {
    const objectType = defineObjectType({
      id: "BadVector",
      name: "Bad Vector",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { query: { searchable: true, text: true } }),
        prop("embedding", "string", { query: { searchable: true, vector: true } }),
      ],
      search: {
        title: "name",
        defaultText: ["name"],
        vector: { property: "embedding", source: ["name"] },
      },
    })

    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(OntologyValidationError)
    expect(() => new OntologyRegistry({ sources: [objectType] })).toThrow(
      "schema is not a numeric array"
    )
  })

  test("rejects vector search profiles with empty or non-text source fields", () => {
    const emptySource = defineObjectType({
      id: "EmptyVectorSource",
      name: "Empty Vector Source",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { query: { searchable: true, text: true } }),
        prop(
          "embedding",
          { type: "array", items: "double" },
          { query: { searchable: true, vector: true } }
        ),
      ],
      search: {
        defaultText: ["name"],
        vector: { property: "embedding", source: [] },
      },
    })
    const nonTextSource = defineObjectType({
      id: "NonTextVectorSource",
      name: "Non Text Vector Source",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { query: { searchable: true, exact: true } }),
        prop(
          "embedding",
          { type: "array", items: "double" },
          { query: { searchable: true, vector: true } }
        ),
      ],
      search: {
        vector: { property: "embedding", source: ["name"] },
      },
    })

    expect(() => new OntologyRegistry({ sources: [emptySource] })).toThrow(OntologyValidationError)
    expect(() => new OntologyRegistry({ sources: [emptySource] })).toThrow(
      "search.vector.source must include at least one source property"
    )
    expect(() => new OntologyRegistry({ sources: [nonTextSource] })).toThrow(
      OntologyValidationError
    )
    expect(() => new OntologyRegistry({ sources: [nonTextSource] })).toThrow(
      "must set query.searchable: true and query.text: true"
    )
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

  test("rejects properties on links that don't define them", () => {
    expect(() =>
      validateLinkProperties(objectType, neighborLink, { foo: "bar" }, undefined, emptyMap)
    ).toThrow(OntologyValidationError)
    expect(() =>
      validateLinkProperties(objectType, neighborLink, { foo: "bar" }, undefined, emptyMap)
    ).toThrow("does not define link properties")
  })

  test("accepts valid link properties", () => {
    expect(() =>
      validateLinkProperties(objectType, deviceLink, { installedBy: "tech-a" }, undefined, emptyMap)
    ).not.toThrow()
  })

  test("rejects unknown link properties", () => {
    expect(() =>
      validateLinkProperties(objectType, deviceLink, { unknown: "val" }, undefined, emptyMap)
    ).toThrow(OntologyValidationError)
    expect(() =>
      validateLinkProperties(objectType, deviceLink, { unknown: "val" }, undefined, emptyMap)
    ).toThrow("Unknown link property 'unknown'")
  })

  test("checks required link properties against merged state", () => {
    // First upsert provides required property
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

  test("fails when required link property is missing from merged state", () => {
    expect(() =>
      validateLinkProperties(objectType, deviceLink, { notes: "test" }, undefined, emptyMap)
    ).toThrow(OntologyValidationError)
    expect(() =>
      validateLinkProperties(objectType, deviceLink, { notes: "test" }, undefined, emptyMap)
    ).toThrow("Missing required link property 'installedBy'")
  })
})

describe("telemetry validation", () => {
  test("assertTelemetryProperty rejects non-telemetry properties", () => {
    const staticProp: Property = {
      id: "name",
      name: "Name",
      schema: "string",
      required: true,
      mode: "static",
    }
    expect(() => assertTelemetryProperty(staticProp)).toThrow(OntologyValidationError)
    expect(() => assertTelemetryProperty(staticProp)).toThrow("not telemetry-enabled")
  })

  test("assertTelemetryProperty accepts telemetry properties", () => {
    const telProp: Property = {
      id: "temp",
      name: "Temp",
      schema: "double",
      required: false,
      mode: "telemetry",
    }
    expect(() => assertTelemetryProperty(telProp)).not.toThrow()
  })

  test("validateTelemetryUnit requires unit when semanticType is set", () => {
    const telProp: Property = {
      id: "temp",
      name: "Temp",
      schema: "double",
      required: false,
      mode: "telemetry",
      semanticType: "Temperature",
    }
    expect(() => validateTelemetryUnit(telProp, "test.temp", undefined, emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateTelemetryUnit(telProp, "test.temp", undefined, emptyMap)).toThrow(
      "Missing unit"
    )
  })

  test("validateTelemetryUnit rejects invalid unit", () => {
    const telProp: Property = {
      id: "temp",
      name: "Temp",
      schema: "double",
      required: false,
      mode: "telemetry",
      semanticType: "Temperature",
    }
    expect(() => validateTelemetryUnit(telProp, "test.temp", "millibar", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateTelemetryUnit(telProp, "test.temp", "millibar", emptyMap)).toThrow(
      "Invalid unit"
    )
  })

  test("validateTelemetryUnit accepts valid unit", () => {
    const telProp: Property = {
      id: "temp",
      name: "Temp",
      schema: "double",
      required: false,
      mode: "telemetry",
      semanticType: "Temperature",
    }
    expect(() =>
      validateTelemetryUnit(telProp, "test.temp", "degreeCelsius", emptyMap)
    ).not.toThrow()
  })

  test("validateTelemetryUnit rejects unit when no semanticType", () => {
    const telProp: Property = {
      id: "count",
      name: "Count",
      schema: "integer",
      required: false,
      mode: "telemetry",
    }
    expect(() => validateTelemetryUnit(telProp, "test.count", "degreeCelsius", emptyMap)).toThrow(
      OntologyValidationError
    )
    expect(() => validateTelemetryUnit(telProp, "test.count", "degreeCelsius", emptyMap)).toThrow(
      "does not define semanticType"
    )
  })

  test("resolveSemanticType follows valueTypeRef", () => {
    const vtMap = new Map<string, ValueType>([
      [
        "Temperature",
        { id: "Temperature", name: "Temperature", schema: "double", semanticType: "Temperature" },
      ],
    ])
    const telProp: Property = {
      id: "temp",
      name: "Temp",
      schema: { type: "valueTypeRef", valueTypeId: "Temperature" },
      required: false,
      mode: "telemetry",
    }
    expect(resolveSemanticType(telProp, vtMap)).toBe("Temperature")
  })

  test("resolveSemanticType returns undefined when no semantic type", () => {
    const telProp: Property = {
      id: "count",
      name: "Count",
      schema: "integer",
      required: false,
      mode: "telemetry",
    }
    expect(resolveSemanticType(telProp, emptyMap)).toBeUndefined()
  })
})
