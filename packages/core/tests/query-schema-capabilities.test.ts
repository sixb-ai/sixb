import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineValueType,
  type ObjectQueryPredicate,
  OntologyRegistry,
  prop,
  type Schema,
  stringEnum,
  valueTypeRef,
} from "../src"
import { collectObjectQueryValidationIssues, validateObjectQuery } from "../src/objects/query"
import { resolvePropertyQueryCapabilities } from "../src/ontology/query-capabilities"

// Pins which query features each schema family supports, at registration (declared `query` flags)
// and at query time (predicate operators and the scalar kind handed to providers). Adding a
// primitive must extend these tables deliberately instead of inheriting string-like behavior.

const Reading = defineValueType({ id: "reading", name: "Reading", schema: "double" })

const schemas = {
  string: "string",
  integer: "integer",
  double: "double",
  decimal: "decimal",
  boolean: "boolean",
  date: "date",
  timestamp: "timestamp",
  uuid: "uuid",
  fileRef: "fileRef",
  stringEnum: stringEnum(["a", "b"]),
  integerEnum: { type: "enum", valueType: "integer", values: [1, 2] },
  array: { type: "array", items: "string" },
  map: { type: "map", keySchema: "string", valueSchema: "string" },
  object: { type: "object", properties: { a: { schema: "string" } } },
  valueTypeRef: valueTypeRef(Reading),
} satisfies Record<string, Schema>

type SchemaName = keyof typeof schemas
type QueryFlag = "text" | "exact" | "filterable" | "sortable" | "facet"
type PropertyOperator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in" | "exists" | "contains"

const flags: readonly QueryFlag[] = ["text", "exact", "filterable", "sortable", "facet"]
const operators: readonly PropertyOperator[] = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "exists",
  "contains",
]

const ordered: QueryFlag[] = ["exact", "filterable", "sortable", "facet"]
const orderedOperators: PropertyOperator[] = ["eq", "neq", "lt", "lte", "gt", "gte", "in", "exists"]

const expectedFlags: Record<SchemaName, QueryFlag[]> = {
  string: ["text", ...ordered],
  integer: ordered,
  double: ordered,
  decimal: ordered,
  boolean: ["exact", "filterable", "facet"],
  date: ordered,
  timestamp: ordered,
  uuid: ordered,
  fileRef: [],
  stringEnum: ["text", ...ordered],
  integerEnum: ordered,
  array: ["filterable"],
  map: ["filterable"],
  object: [],
  valueTypeRef: ordered,
}

const expectedOperators: Record<SchemaName, PropertyOperator[]> = {
  string: [...orderedOperators, "contains"],
  integer: orderedOperators,
  double: orderedOperators,
  decimal: orderedOperators,
  boolean: ["eq", "neq", "in", "exists"],
  date: orderedOperators,
  timestamp: orderedOperators,
  uuid: [...orderedOperators, "contains"],
  fileRef: [],
  stringEnum: orderedOperators,
  integerEnum: orderedOperators,
  array: ["contains"],
  map: ["contains"],
  object: [],
  valueTypeRef: orderedOperators,
}

const expectedScalarKinds: Partial<Record<SchemaName, string>> = {
  string: "string",
  integer: "integer",
  double: "double",
  decimal: "decimal",
  boolean: "boolean",
  date: "date",
  timestamp: "timestamp",
  uuid: "uuid",
  stringEnum: "string",
  integerEnum: "integer",
  valueTypeRef: "double",
}

const sampleValues: Record<SchemaName, unknown> = {
  string: "a",
  integer: 1,
  double: 1.5,
  decimal: "1.5",
  boolean: true,
  date: "2026-01-01",
  timestamp: "2026-01-01T00:00:00.000Z",
  uuid: "00000000-0000-4000-8000-000000000000",
  fileRef: undefined,
  stringEnum: "a",
  integerEnum: 1,
  array: "a",
  map: "a",
  object: undefined,
  valueTypeRef: 1.5,
}

const schemaNames = Object.keys(schemas) as SchemaName[]

function registryFor(
  name: SchemaName,
  query: Record<string, boolean>,
  mode: "static" | "telemetry" = "static"
): OntologyRegistry {
  const objectType = defineObjectType({
    id: "item",
    name: "Item",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("value", schemas[name] as Schema, { mode, query: { searchable: true, ...query } }),
    ],
  })
  return new OntologyRegistry({
    sources: [{ id: "doc", version: "1", objectTypes: [objectType], valueTypes: [Reading] }],
  })
}

function acceptedFlags(name: SchemaName): QueryFlag[] {
  return flags.filter((flag) => {
    try {
      registryFor(name, { [flag]: true })
      return true
    } catch {
      return false
    }
  })
}

function predicateFor(operator: PropertyOperator, value: unknown): ObjectQueryPredicate {
  if (operator === "in") return { op: "in", propertyId: "value", values: [value] }
  if (operator === "exists") return { op: "exists", propertyId: "value", value: true }
  return { op: operator, propertyId: "value", value }
}

function acceptedOperators(name: SchemaName): PropertyOperator[] {
  if (!expectedFlags[name].includes("filterable")) return []
  const ontology = registryFor(name, { filterable: true })
  return operators.filter((operator) => {
    const issues = collectObjectQueryValidationIssues(
      {
        kind: "filter",
        input: { kind: "start", objectTypeId: "item" },
        predicate: predicateFor(operator, sampleValues[name]),
      },
      { ontology }
    )
    return !issues.some(
      (issue) =>
        issue.code === "operator_not_supported_for_schema" ||
        issue.code === "property_not_filterable"
    )
  })
}

describe("query capabilities by schema", () => {
  test("registration accepts exactly the query flags each schema supports", () => {
    expect(Object.fromEntries(schemaNames.map((name) => [name, acceptedFlags(name)]))).toEqual(
      expectedFlags
    )
  })

  test("predicates accept exactly the operators each filterable schema supports", () => {
    expect(Object.fromEntries(schemaNames.map((name) => [name, acceptedOperators(name)]))).toEqual(
      expectedOperators
    )
  })

  test("predicates and sorts resolve the scalar kind providers compare with", () => {
    const resolved: Partial<Record<SchemaName, string>> = {}
    for (const name of schemaNames) {
      if (!expectedFlags[name].includes("sortable")) continue
      const ontology = registryFor(name, { filterable: true, sortable: true })
      const validated = validateObjectQuery(
        {
          kind: "sort",
          input: {
            kind: "filter",
            input: { kind: "start", objectTypeId: "item" },
            predicate: { op: "eq", propertyId: "value", value: sampleValues[name] },
          },
          fields: [{ kind: "property", propertyId: "value" }],
        },
        { ontology }
      )
      if (validated.query.kind !== "sort" || validated.query.input.kind !== "filter") {
        throw new Error("unexpected validated query shape")
      }
      const predicate = validated.query.input.predicate
      const field = validated.query.fields[0]
      const predicateKind = "scalarKind" in predicate ? predicate.scalarKind : undefined
      const sortKind = field?.kind === "property" ? field.scalarKind : undefined
      expect(sortKind).toBe(predicateKind)
      if (predicateKind) resolved[name] = predicateKind
    }

    // Boolean is exact-matchable but not orderable, so it is checked through `eq` alone.
    const booleanQuery = validateObjectQuery(
      {
        kind: "filter",
        input: { kind: "start", objectTypeId: "item" },
        predicate: { op: "eq", propertyId: "value", value: true },
      },
      { ontology: registryFor("boolean", { filterable: true }) }
    )
    if (booleanQuery.query.kind === "filter" && "scalarKind" in booleanQuery.query.predicate) {
      resolved.boolean = booleanQuery.query.predicate.scalarKind
    }

    expect(resolved).toEqual(expectedScalarKinds)
  })
})

function capabilitiesOf(ontology: OntologyRegistry, propertyId: string) {
  const property = ontology
    .getObjectTypeById("item")
    ?.properties.find((candidate) => candidate.id === propertyId)
  if (!property) throw new Error(`missing property ${propertyId}`)
  return resolvePropertyQueryCapabilities(property, ontology.getValueTypesById())
}

describe("resolved property query capabilities", () => {
  test("report exactly what registration and query validation accept", () => {
    for (const name of schemaNames) {
      const declared = Object.fromEntries(expectedFlags[name].map((flag) => [flag, true]))
      const capabilities = capabilitiesOf(registryFor(name, declared), "value")
      expect({ name, ...capabilities, operators: [...capabilities.operators].sort() }).toEqual({
        name,
        operators: acceptedOperators(name).sort(),
        sortable: expectedFlags[name].includes("sortable"),
        facet: expectedFlags[name].includes("facet"),
        text: expectedFlags[name].includes("text"),
      })
    }
  })

  test("need the matching query flag, not just a capable schema", () => {
    expect(capabilitiesOf(registryFor("string", {}), "value")).toEqual({
      operators: [],
      sortable: false,
      facet: false,
      text: false,
    })
  })

  test("primary ids accept eq and in without query metadata", () => {
    expect(capabilitiesOf(registryFor("string", {}), "id")).toEqual({
      operators: ["eq", "in"],
      sortable: false,
      facet: false,
      text: false,
    })
  })

  test("exclude keyword search on telemetry, which is not object-query indexed", () => {
    const ontology = registryFor("string", { text: true, filterable: true }, "telemetry")
    expect(capabilitiesOf(ontology, "value").text).toBe(false)
    const issues = collectObjectQueryValidationIssues(
      {
        kind: "text",
        input: { kind: "start", objectTypeId: "item" },
        query: "a",
        fields: ["value"],
      },
      { ontology }
    )
    expect(issues.map((issue) => issue.code)).toContain("telemetry_search_property")
  })
})
