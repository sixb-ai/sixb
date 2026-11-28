import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineValueType,
  integerEnum,
  link,
  OntologyRegistry,
  type OntologySource,
  type Property,
  prop,
  stringEnum,
  valueTypeRef,
} from "../src"
import {
  diffTypeShapes,
  schemaWidens,
  type TypeShape,
  type TypeShapeChange,
  typeShape,
  withoutRemovedTargets,
} from "../src/ontology/type-shapes"
import type { ObjectLink, ValueType } from "../src/ontology/types"

const Technician = defineObjectType({
  id: "ShapeTechnician",
  name: "Technician",
  properties: [prop("id", "string", { primary: true, required: true })],
  links: [],
})

const Contractor = defineObjectType({
  id: "ShapeContractor",
  name: "Contractor",
  properties: [prop("id", "string", { primary: true, required: true })],
  links: [],
})

/** The shape of a `Job` with these properties and links, next to its link targets. */
function jobShape(
  properties: readonly Property[],
  options: {
    readonly links?: readonly ObjectLink[]
    readonly valueTypes?: readonly ValueType[]
  } = {}
): TypeShape {
  const Job = defineObjectType({
    id: "ShapeJob",
    name: "Job",
    properties: [prop("ref", "string", { primary: true, required: true }), ...properties],
    links: [...(options.links ?? [])],
  })
  const ontology = new OntologyRegistry({
    sources: [
      {
        id: "shapes",
        version: "1",
        objectTypes: [Job, Technician, Contractor],
        valueTypes: [...(options.valueTypes ?? [])],
      },
    ],
  })
  return typeShape(ontology.resolveObjectType(Job.id), ontology)
}

/** The changes from `before` to `after`, as `kind:effect` with the property or link id. */
function changes(before: TypeShape, after: TypeShape | null): string[] {
  return diffTypeShapes(before, after).map(label)
}

function label(change: TypeShapeChange): string {
  const id = "propertyId" in change ? change.propertyId : "linkId" in change ? change.linkId : ""
  return `${change.kind}${id ? `(${id})` : ""}:${change.effect}`
}

describe("typeShape", () => {
  test("writes value types and nested fields in place, without names or descriptions", () => {
    const Hours = defineValueType({
      id: "shapeHours",
      name: "Hours",
      description: "Billable hours",
      schema: {
        type: "object",
        properties: {
          value: { schema: "double", required: true, description: "Amount" },
          note: { schema: "string", nullable: true },
        },
      },
    })

    const shape = jobShape(
      [
        prop("hours", valueTypeRef(Hours), { nullable: true, description: "Logged" }),
        prop("status", stringEnum(["scheduled", "done"]), { required: true, unique: true }),
        prop("temperature", "double", { mode: "telemetry" }),
      ],
      { links: [link("crew", Technician, { cardinality: "many" })], valueTypes: [Hours] }
    )

    expect(shape).toEqual({
      properties: {
        hours: {
          nullable: true,
          schema: {
            properties: {
              note: { nullable: true, schema: "string" },
              value: { required: true, schema: "double" },
            },
            type: "object",
          },
        },
        ref: { primary: true, required: true, schema: "string" },
        status: {
          required: true,
          schema: { type: "enum", valueType: "string", values: ["scheduled", "done"] },
          unique: true,
        },
        temperature: { mode: "telemetry", schema: "double" },
      },
      links: { crew: { cardinality: "many", targets: [Technician.id] } },
    })
  })

  test("serializes the same whatever order the code declares things in", () => {
    const forward = jobShape([prop("a", "string"), prop("b", "integer")])
    const backward = jobShape([prop("b", "integer"), prop("a", "string")])

    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward))
  })

  test("gives a subtype its inherited properties and links", () => {
    const Asset = defineObjectType({
      id: "ShapeAsset",
      name: "Asset",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("serial", "string"),
      ],
      links: [link("maintainer", Technician)],
    })
    const Pump = defineObjectType({
      id: "ShapePump",
      name: "Pump",
      extends: Asset.id,
      properties: [prop("flow", "double")],
      links: [],
    })
    const ontology = new OntologyRegistry({ sources: [Asset, Pump, Technician] })

    const shape = typeShape(ontology.resolveObjectType(Pump.id), ontology)
    expect(Object.keys(shape.properties)).toEqual(["flow", "id", "serial"])
    expect(shape.properties.id).toMatchObject({ primary: true })
    expect(Object.keys(shape.links)).toEqual(["maintainer"])
  })
})

describe("diffTypeShapes", () => {
  test("finds nothing between a shape and itself", () => {
    const shape = jobShape([prop("gate", "string")], { links: [link("crew", Technician)] })
    expect(changes(shape, shape)).toEqual([])
  })

  test("a new optional property needs nothing; a new required one narrows", () => {
    const before = jobShape([])

    expect(changes(before, jobShape([prop("note", "string")]))).toEqual([
      "property-added(note):compatible",
    ])
    expect(changes(before, jobShape([prop("crewLead", "string", { required: true })]))).toEqual([
      "property-added(crewLead):narrowing",
    ])
  })

  test("a removed property narrows, and a removed telemetry property is refused", () => {
    expect(changes(jobShape([prop("gate", "string")]), jobShape([]))).toEqual([
      "property-removed(gate):narrowing",
    ])
    expect(
      changes(jobShape([prop("temp", "double", { mode: "telemetry" })]), jobShape([]))
    ).toEqual(["property-removed(temp):refused"])
  })

  test("required added narrows, required dropped widens", () => {
    const optional = jobShape([prop("crewLead", "string")])
    const required = jobShape([prop("crewLead", "string", { required: true })])

    expect(changes(optional, required)).toEqual(["property-required(crewLead):narrowing"])
    expect(changes(required, optional)).toEqual(["property-optional(crewLead):compatible"])
  })

  test("nullable added widens, nullable removed narrows", () => {
    const strict = jobShape([prop("note", "string")])
    const nullable = jobShape([prop("note", "string", { nullable: true })])

    expect(changes(strict, nullable)).toEqual(["property-nullable(note):compatible"])
    expect(changes(nullable, strict)).toEqual(["property-not-nullable(note):narrowing"])
  })

  test("enum values added widen, enum values removed narrow", () => {
    const two = jobShape([prop("status", stringEnum(["scheduled", "done"]))])
    const three = jobShape([prop("status", stringEnum(["scheduled", "done", "cancelled"]))])

    expect(changes(two, three)).toEqual(["property-retyped(status):compatible"])
    expect(changes(three, two)).toEqual(["property-retyped(status):narrowing"])
  })

  test("integer to double widens, double to integer narrows", () => {
    const integer = jobShape([prop("hours", "integer")])
    const double = jobShape([prop("hours", "double")])

    expect(changes(integer, double)).toEqual(["property-retyped(hours):compatible"])
    expect(changes(double, integer)).toEqual(["property-retyped(hours):narrowing"])
  })

  test("string to double narrows both ways, a string enum to string widens", () => {
    const text = jobShape([prop("hours", "string")])
    const number = jobShape([prop("hours", "double")])
    expect(changes(text, number)).toEqual(["property-retyped(hours):narrowing"])
    expect(changes(number, text)).toEqual(["property-retyped(hours):narrowing"])

    const enumerated = jobShape([prop("hours", stringEnum(["1", "2"]))])
    expect(changes(enumerated, text)).toEqual(["property-retyped(hours):compatible"])
    expect(changes(text, enumerated)).toEqual(["property-retyped(hours):narrowing"])
  })

  test("an integer enum widens to integer and double, never to a decimal string", () => {
    expect(schemaWidens(integerEnum([1, 2]), "integer")).toBe(true)
    expect(schemaWidens(integerEnum([1, 2]), "double")).toBe(true)
    expect(schemaWidens("integer", "decimal")).toBe(false)
    expect(schemaWidens("uuid", "string")).toBe(true)
    expect(schemaWidens("string", "uuid")).toBe(false)
  })

  test("compares value types by what they accept, not by their names", () => {
    const fields = (value: "integer" | "double", extra = {}) => ({
      type: "object" as const,
      properties: { value: { schema: value, required: true }, ...extra },
    })
    const Old = defineValueType({ id: "shapeOld", name: "Old", schema: fields("integer") })
    const Renamed = defineValueType({
      id: "shapeRenamed",
      name: "Renamed",
      schema: fields("integer"),
    })
    const Wider = defineValueType({ id: "shapeWider", name: "Wider", schema: fields("double") })
    const Stricter = defineValueType({
      id: "shapeStricter",
      name: "Stricter",
      schema: fields("integer", { unit: { schema: "string", required: true } }),
    })
    const shape = (valueType: ValueType) =>
      jobShape([prop("hours", valueTypeRef(valueType))], { valueTypes: [valueType] })

    expect(changes(shape(Old), shape(Renamed))).toEqual([])
    expect(changes(shape(Old), shape(Wider))).toEqual(["property-retyped(hours):compatible"])
    expect(changes(shape(Wider), shape(Old))).toEqual(["property-retyped(hours):narrowing"])
    expect(changes(shape(Old), shape(Stricter))).toEqual(["property-retyped(hours):narrowing"])
    expect(changes(shape(Stricter), shape(Old))).toEqual(["property-retyped(hours):narrowing"])
  })

  test("nested fields follow the property rules: optional added widens, required added narrows", () => {
    const base = { value: { schema: "double" as const, required: true } }
    const shape = (
      properties: Record<
        string,
        { schema: "double" | "string"; required?: boolean; nullable?: boolean }
      >
    ) => jobShape([prop("reading", { type: "object", properties })])

    expect(changes(shape(base), shape({ ...base, note: { schema: "string" } }))).toEqual([
      "property-retyped(reading):compatible",
    ])
    expect(changes(shape(base), shape({ value: { schema: "double" } }))).toEqual([
      "property-retyped(reading):compatible",
    ])
    expect(changes(shape({ value: { schema: "double" } }), shape(base))).toEqual([
      "property-retyped(reading):narrowing",
    ])
    expect(
      changes(shape(base), shape({ value: { schema: "double", required: true, nullable: true } }))
    ).toEqual(["property-retyped(reading):compatible"])
  })

  test("a property never set before is unknown: declaring it narrows", () => {
    const stored: TypeShape = {
      ...jobShape([]),
      properties: { ...jobShape([]).properties, gate: { schema: "unknown" } },
    }

    expect(changes(stored, jobShape([]))).toEqual(["property-removed(gate):narrowing"])
    expect(changes(stored, jobShape([prop("gate", "string")]))).toEqual([
      "property-retyped(gate):narrowing",
    ])
  })

  test("a mode change is refused, both ways", () => {
    const fact = jobShape([prop("temp", "double")])
    const series = jobShape([prop("temp", "double", { mode: "telemetry" })])

    expect(changes(fact, series)).toEqual(["property-mode(temp):refused"])
    expect(changes(series, fact)).toEqual(["property-mode(temp):refused"])
  })

  test("a telemetry property may widen; narrowing it is refused", () => {
    const integer = jobShape([prop("count", "integer", { mode: "telemetry" })])
    const double = jobShape([prop("count", "double", { mode: "telemetry" })])

    expect(changes(integer, double)).toEqual(["property-retyped(count):compatible"])
    expect(changes(double, integer)).toEqual(["property-retyped(count):refused"])
  })

  // Removal proof: in `diffProperty`, make `unique` added compatible again; the deploy then records
  // it while the old release still writes values two objects may share.
  test("unique added, or compared another way, narrows; unique removed widens", () => {
    const plain = jobShape([prop("code", "string")])
    const unique = jobShape([prop("code", "string", { unique: true })])
    const integer = jobShape([prop("code", "integer", { unique: true })])
    const uuid = jobShape([prop("code", "uuid", { unique: true })])

    expect(changes(plain, unique)).toEqual(["property-unique(code):narrowing"])
    expect(changes(unique, plain)).toEqual(["property-unique(code):compatible"])
    expect(changes(unique, integer)).toEqual([
      "property-retyped(code):narrowing",
      "property-unique(code):narrowing",
    ])
    // Another schema whose values compare the same way: nothing to rebuild.
    expect(changes(unique, uuid)).toEqual(["property-retyped(code):narrowing"])
  })

  test("a changed primary property is one refused change", () => {
    const Job = (primary: "ref" | "code") =>
      defineObjectType({
        id: "ShapeJob",
        name: "Job",
        properties: [
          prop("ref", "string", primary === "ref" ? { primary: true, required: true } : {}),
          prop("code", "string", primary === "code" ? { primary: true, required: true } : {}),
        ],
        links: [],
      })
    const shape = (primary: "ref" | "code") => {
      const ontology = new OntologyRegistry({ sources: [Job(primary)] })
      return typeShape(ontology.resolveObjectType("ShapeJob"), ontology)
    }

    expect(changes(shape("ref"), shape("code"))).toEqual(["primary:refused"])
  })

  test("a link added widens, a link removed narrows", () => {
    const without = jobShape([])
    const withCrew = jobShape([], { links: [link("crew", Technician)] })

    expect(changes(without, withCrew)).toEqual(["link-added(crew):compatible"])
    expect(changes(withCrew, without)).toEqual(["link-removed(crew):narrowing"])
  })

  test("an added link target widens; a removed one retargets the link and is refused", () => {
    const one = jobShape([], { links: [link.ref("crew", Technician.id)] })
    const both = jobShape([], { links: [link.ref("crew", [Technician.id, Contractor.id])] })

    expect(changes(one, both)).toEqual(["link-targets(crew):compatible"])
    expect(changes(both, one)).toEqual(["link-targets(crew):refused"])
  })

  describe("a link's targets are the types it accepts, subtypes included", () => {
    // Revert check: build `linkShape`'s targets from the declared ids alone
    // (`[link.targetObjectTypeId].flat().sort()`) and drop the `"*"` test in `diffLink`: each of
    // these fails.
    const Space = defineObjectType({
      id: "ShapeSpace",
      name: "Space",
      properties: [prop("id", "string", { primary: true, required: true })],
      links: [],
    })
    const Room = defineObjectType({ ...Space, id: "ShapeRoom", name: "Room", extends: Space.id })
    const Office = defineObjectType({
      ...Space,
      id: "ShapeOffice",
      name: "Office",
      extends: Space.id,
    })

    function visitShape(at: ObjectLink, spaces: readonly OntologySource[]): TypeShape {
      const Visit = defineObjectType({
        id: "ShapeVisit",
        name: "Visit",
        properties: [prop("ref", "string", { primary: true, required: true })],
        links: [at],
      })
      const ontology = new OntologyRegistry({ sources: [Visit, ...spaces] })
      return typeShape(ontology.resolveObjectType(Visit.id), ontology)
    }

    test("widening a link to a supertype is compatible", () => {
      const room = visitShape(link("at", Room), [Space, Room])
      const space = visitShape(link("at", Space), [Space, Room])

      expect(space.links.at!.targets).toEqual([Room.id, Space.id])
      expect(changes(room, space)).toEqual(["link-targets(at):compatible"])
    })

    test("widening a link to link.any is compatible, and narrowing it back is refused", () => {
      const room = visitShape(link("at", Room), [Space, Room])
      const any = visitShape(link.any("at"), [Space, Room])

      expect(any.links.at!.targets).toEqual(["*"])
      expect(changes(room, any)).toEqual(["link-targets(at):compatible"])
      expect(changes(any, room)).toEqual(["link-targets(at):refused"])
    })

    test("a new subtype of a target is compatible", () => {
      const before = visitShape(link("at", Space), [Space, Room])
      const after = visitShape(link("at", Space), [Space, Room, Office])

      expect(changes(before, after)).toEqual(["link-targets(at):compatible"])
    })

    // Revert check: return `stored` unchanged from `withoutRemovedTargets`: the link is refused
    // for a type no object can be any more.
    test("a removed subtype doesn't retarget the link: its own removal probes its objects", () => {
      const before = visitShape(link("at", Space), [Space, Room, Office])
      const ontology = new OntologyRegistry({ sources: [Space, Room] })
      const after = visitShape(link("at", Space), [Space, Room])

      expect(changes(before, after)).toEqual(["link-targets(at):refused"])
      expect(changes(withoutRemovedTargets(before, ontology), after)).toEqual([])
    })

    test("a subtype that leaves the hierarchy retargets the link and is refused", () => {
      const before = visitShape(link("at", Space), [Space, Room])
      const LoneRoom = defineObjectType({ ...Space, id: Room.id, name: "Room" })
      const after = visitShape(link("at", Space), [Space, LoneRoom])

      expect(changes(before, after)).toEqual(["link-targets(at):refused"])
    })
  })

  test("a cardinality change is refused, both ways", () => {
    const many = jobShape([], { links: [link("crew", Technician, { cardinality: "many" })] })
    const one = jobShape([], { links: [link("crew", Technician, { cardinality: "one" })] })

    expect(changes(many, one)).toEqual(["link-cardinality(crew):refused"])
    expect(changes(one, many)).toEqual(["link-cardinality(crew):refused"])
  })

  test("leaves a link's properties out of the shape in V1", () => {
    const plain = jobShape([], {
      links: [link("crew", Technician, { properties: [prop("role", "string")] })],
    })
    const required = jobShape([], {
      links: [
        link("crew", Technician, { properties: [prop("role", "string", { required: true })] }),
      ],
    })

    expect(changes(plain, required)).toEqual([])
  })

  test("a type the code no longer defines is refused until its data is gone", () => {
    expect(changes(jobShape([]), null)).toEqual(["type-removed:refused"])
  })

  test("a stored shape read back with its keys in another order is the same shape", () => {
    const shape = jobShape([prop("status", stringEnum(["a", "b"]), { required: true })])
    const reordered = JSON.parse(
      JSON.stringify(shape, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value
      )
    ) as TypeShape

    expect(changes(reordered, shape)).toEqual([])
  })
})
