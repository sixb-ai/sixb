import { describe, expect, test } from "bun:test"
import type { ObjectLink, ObjectType, Property } from "../src/ontology"
import {
  defineInterface,
  defineObjectType,
  defineOntology,
  defineValueType,
  integerEnum,
  link,
  prop,
  stringEnum,
} from "../src/ontology"

const Room = defineObjectType({
  id: "room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Floor = defineObjectType({
  id: "floor",
  name: "Floor",
  properties: [prop("id", "string", { required: true, primary: true })],
})

describe("defineObjectType", () => {
  test("defaults properties and links to empty arrays and passes optional fields through", () => {
    const bare: ObjectType = defineObjectType({ id: "bare", name: "Bare" })
    expect(bare.properties).toEqual([])
    expect(bare.links).toEqual([])
    expect(bare.quantityKind).toBeUndefined()
    expect(bare.seeAlso).toBeUndefined()

    const sensor = defineObjectType({
      id: "sensor",
      name: "Sensor",
      description: "A generic sensor",
      implements: ["measurable"],
      quantityKind: "Temperature",
      seeAlso: ["https://example.com/docs"],
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link.ref("locatedIn", "room")],
      search: { title: "id", exact: ["id"] },
    })
    expect(sensor).toMatchObject({
      description: "A generic sensor",
      implements: ["measurable"],
      quantityKind: "Temperature",
      seeAlso: ["https://example.com/docs"],
      search: { title: "id", exact: ["id"] },
    })
    expect(sensor.properties.map((property) => property.id)).toEqual(["id"])
    expect(sensor.links.map((objectLink) => objectLink.id)).toEqual(["locatedIn"])
  })

  test("resolves a self link to the defining object type id", () => {
    const Folder = defineObjectType({
      id: "Folder",
      name: "Folder",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link.self("parent", { cardinality: "one" })],
    })

    expect(Folder.links[0]?.targetObjectTypeId).toBe("Folder")
    expect(Folder.l.parent.targetObjectTypeId).toBe("Folder")
  })
})

describe("defineOntology, defineInterface, defineValueType", () => {
  test("default their collections to empty arrays and keep the ones provided", () => {
    expect(defineOntology({ id: "hvac", version: "1.0.0" })).toEqual({
      id: "hvac",
      version: "1.0.0",
      objectTypes: [],
      valueTypes: [],
      interfaces: [],
    })
    expect(defineInterface({ id: "controllable", name: "Controllable" })).toEqual({
      id: "controllable",
      name: "Controllable",
      properties: [],
      links: [],
    })

    const reading = defineValueType({
      id: "temperatureReading",
      name: "Temperature Reading",
      schema: "double",
      semanticType: "Temperature",
    })
    const measurable = defineInterface({ id: "measurable", name: "Measurable" })
    const ontology = defineOntology({
      id: "hvac",
      version: "1.1.0",
      objectTypes: [Room],
      valueTypes: [reading],
      interfaces: [measurable],
    })
    expect(ontology.objectTypes).toEqual([Room])
    expect(ontology.valueTypes).toEqual([reading])
    expect(ontology.interfaces).toEqual([measurable])
  })

  test("defineValueType returns its input unchanged", () => {
    const input = {
      id: "temperatureReading",
      name: "Temperature Reading",
      schema: "double",
      semanticType: "Temperature",
    } as const
    expect(defineValueType(input)).toBe(input)
  })
})

describe("prop", () => {
  test.each<{ name: string; property: Property; expected: Property }>([
    {
      name: "uses the id as the default name",
      property: prop("serialNumber", "string"),
      expected: { id: "serialNumber", name: "serialNumber", schema: "string" },
    },
    {
      name: "passes every option through",
      property: prop("externalId", "double", {
        name: "External ID",
        description: "Unique external identifier",
        required: true,
        nullable: false,
        primary: true,
        mode: "telemetry",
        semanticType: "Temperature",
        query: { searchable: true, filterable: true, sortable: true },
      }),
      expected: {
        id: "externalId",
        name: "External ID",
        schema: "double",
        description: "Unique external identifier",
        required: true,
        nullable: false,
        primary: true,
        mode: "telemetry",
        semanticType: "Temperature",
        query: { searchable: true, filterable: true, sortable: true },
      },
    },
  ])("$name", ({ property, expected }) => {
    expect(property).toEqual(expected)
  })
})

describe("link", () => {
  test.each<{ name: string; objectLink: ObjectLink; expected: ObjectLink }>([
    {
      name: "ref uses the id as the default name",
      objectLink: link.ref("locatedIn", "space"),
      expected: { id: "locatedIn", name: "locatedIn", targetObjectTypeId: "space" },
    },
    {
      name: "ref accepts options",
      objectLink: link.ref("contains", "room", {
        name: "Contains",
        cardinality: "many",
        description: "Rooms in this building",
        properties: [prop("installedAt", "timestamp", { required: true })],
      }),
      expected: {
        id: "contains",
        name: "Contains",
        targetObjectTypeId: "room",
        cardinality: "many",
        description: "Rooms in this building",
        properties: [
          { id: "installedAt", name: "installedAt", schema: "timestamp", required: true },
        ],
      },
    },
    {
      name: "ref accepts id arrays",
      objectLink: link.ref("controls", ["thermostat", "valve"]),
      expected: {
        id: "controls",
        name: "controls",
        targetObjectTypeId: ["thermostat", "valve"],
      },
    },
    {
      name: "any targets '*'",
      objectLink: link.any("assignedTo"),
      expected: { id: "assignedTo", name: "assignedTo", targetObjectTypeId: "*" },
    },
    {
      name: "any accepts options",
      objectLink: link.any("assignedTo", { name: "Assigned To", cardinality: "one" }),
      expected: {
        id: "assignedTo",
        name: "Assigned To",
        targetObjectTypeId: "*",
        cardinality: "one",
      },
    },
    {
      name: "an ObjectType target contributes only its id",
      objectLink: link("locatedIn", Room),
      expected: { id: "locatedIn", name: "locatedIn", targetObjectTypeId: "room" },
    },
    {
      name: "an ObjectType target accepts options",
      objectLink: link("locatedIn", Room, { cardinality: "one" }),
      expected: {
        id: "locatedIn",
        name: "locatedIn",
        targetObjectTypeId: "room",
        cardinality: "one",
      },
    },
    {
      name: "ObjectType array targets contribute their ids",
      objectLink: link("locatedIn", [Room, Floor], { cardinality: "many" }),
      expected: {
        id: "locatedIn",
        name: "locatedIn",
        targetObjectTypeId: ["room", "floor"],
        cardinality: "many",
      },
    },
  ])("$name", ({ objectLink, expected }) => {
    expect(objectLink).toEqual(expected)
    expect(Object.getOwnPropertySymbols(objectLink)).toEqual([])
  })
})

describe("enum helpers", () => {
  test("stringEnum and integerEnum build enum schemas", () => {
    expect(stringEnum(["off", "heat"])).toEqual({
      type: "enum",
      valueType: "string",
      values: ["off", "heat"],
    })
    expect(integerEnum([1, 2, 3])).toEqual({
      type: "enum",
      valueType: "integer",
      values: [1, 2, 3],
    })
  })
})
