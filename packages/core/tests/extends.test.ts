import { describe, expect, test } from "bun:test"
import type { ObjectType } from "../src"
import {
  defineObjectType,
  link,
  MaterializationValidationError,
  OntologyValidationError,
  prop,
} from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// ── Fixtures ────────────────────────────────────────────────

const Equipment = defineObjectType({
  id: "Equipment",
  name: "Equipment",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("manufacturer", "string"),
  ],
  links: [link.ref("locatedIn", "Location", { cardinality: "one" })],
})

const HVACEquipment = defineObjectType({
  extends: Equipment,
  id: "HVACEquipment",
  name: "HVAC Equipment",
  properties: [prop("capacity", "double")],
  links: [link.ref("feeds", "Equipment", { cardinality: "many" })],
})

const AHU = defineObjectType({
  extends: HVACEquipment,
  id: "AHU",
  name: "Air Handling Unit",
  properties: [prop("filterType", "string")],
})

const Location = defineObjectType({
  id: "Location",
  name: "Location",
  properties: [prop("id", "string", { required: true, primary: true }), prop("address", "string")],
})

const WaterHeater = defineObjectType({
  id: "WaterHeater",
  name: "Water Heater",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

const Boiler = defineObjectType({
  extends: HVACEquipment,
  id: "Boiler",
  name: "Boiler",
  parents: ["WaterHeater"],
})

const ontology = [Equipment, HVACEquipment, AHU, Location, WaterHeater, Boiler]

function sixbWith(types: readonly ObjectTypeLike[] = ontology) {
  return createTestSixb({ ontology: [...types], ...createTestRuntimeDeps() })
}

type ObjectTypeLike = (typeof ontology)[number] | ReturnType<typeof defineObjectType>

describe("defineObjectType with extends", () => {
  test("merges ancestor properties and links through every level, the child winning by id", () => {
    expect(Equipment.extends).toBeUndefined()
    expect(HVACEquipment.extends).toBe("Equipment")
    // The inferred type says `parents` is undefined here; at runtime it carries the parent.
    expect((HVACEquipment as ObjectType).parents).toEqual(["Equipment"])
    expect(AHU.properties.map((property) => property.id)).toEqual([
      "id",
      "name",
      "manufacturer",
      "capacity",
      "filterType",
    ])
    expect(AHU.links.map((objectLink) => objectLink.id)).toEqual(["locatedIn", "feeds"])

    // Inherited tokens are bound to the child, not to the type that declared them.
    expect(HVACEquipment.p.name.objectTypeId).toBe("HVACEquipment")
    expect(HVACEquipment.p.capacity.objectTypeId).toBe("HVACEquipment")
    expect(HVACEquipment.l.locatedIn.objectTypeId).toBe("HVACEquipment")
    expect(HVACEquipment.l.feeds.objectTypeId).toBe("HVACEquipment")

    const Parent = defineObjectType({
      id: "P",
      name: "P",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("status", "string"),
        prop("extra", "boolean"),
      ],
    })
    const Child = defineObjectType({
      extends: Parent,
      id: "C",
      name: "C",
      properties: [prop("status", "integer")],
    })
    // An override leaves the parent's slot and joins the child's own properties.
    expect(Child.properties.map((property) => [property.id, property.schema])).toEqual([
      ["id", "string"],
      ["extra", "boolean"],
      ["status", "integer"],
    ])
  })

  test("takes a pre-flattened string extends as-is", () => {
    const PreFlattened = defineObjectType({
      id: "PreFlattened",
      name: "Pre-Flattened Type",
      extends: "brick:Equipment",
      parents: ["brick:Sensor", "brick:Equipment"],
      properties: [prop("inheritedProp", "string"), prop("ownProp", "double", { required: true })],
      links: [link.ref("hasLocation", "brick:Location")],
    })

    expect(PreFlattened.extends).toBe("brick:Equipment")
    expect(PreFlattened.parents).toEqual(["brick:Equipment", "brick:Sensor"])
    expect(PreFlattened.properties.map((property) => property.id)).toEqual([
      "inheritedProp",
      "ownProp",
    ])
    expect(PreFlattened.links.map((objectLink) => objectLink.id)).toEqual(["hasLocation"])
    expect(PreFlattened.p.ownProp.objectTypeId).toBe("PreFlattened")
    expect(PreFlattened.l.hasLocation.objectTypeId).toBe("PreFlattened")
  })

  test("lists the structural parent first among parents, once, and inherits only from it", () => {
    expect(Boiler.extends).toBe("HVACEquipment")
    expect(Boiler.parents as string[]).toEqual(["HVACEquipment", "WaterHeater"])
    expect(Boiler.properties.map((property) => property.id)).toEqual(
      HVACEquipment.properties.map((property) => property.id)
    )

    const Dedup = defineObjectType({
      extends: Equipment,
      id: "Dedup",
      name: "Dedup",
      parents: ["Equipment", "WaterHeater"],
    })
    expect(Dedup.parents).toEqual(["Equipment", "WaterHeater"])

    const Standalone = defineObjectType({
      id: "Standalone",
      name: "Standalone",
      properties: [prop("id", "string", { required: true, primary: true })],
      parents: ["SomeParent"],
    })
    expect(Standalone.extends).toBeUndefined()
    expect(Standalone.parents).toEqual(["SomeParent"])
  })
})

describe("SixbHost hierarchy validation", () => {
  // A real cycle can't be built through defineObjectType(), whose parent must exist at call time,
  // so the cycle and the unknown parent are literal objects naming each other's ids.
  test.each([
    {
      name: "an extends of an unknown type",
      types: [
        defineObjectType({
          extends: { id: "nonexistent", properties: [], links: [] },
          id: "Orphan",
          name: "Orphan",
        }),
      ],
      messages: ['extends unknown type "nonexistent"', "add it to 'ontologies' in createSixb()"],
    },
    {
      name: "a circular extends chain",
      types: [
        defineObjectType({
          id: "CycleA",
          name: "A",
          extends: { id: "CycleB", properties: [], links: [] },
        }),
        defineObjectType({
          id: "CycleB",
          name: "B",
          extends: { id: "CycleA", properties: [], links: [] },
        }),
      ],
      messages: ["Circular extends chain detected"],
    },
    {
      name: "an unknown type in parents",
      types: [
        defineObjectType({
          id: "BadParent",
          name: "Bad",
          properties: [prop("id", "string", { required: true, primary: true })],
          parents: ["nonexistent"],
        }),
      ],
      messages: [
        'lists unknown parent "nonexistent" in parents',
        "add it to 'ontologies' in createSixb()",
      ],
    },
  ])("rejects $name", ({ types, messages }) => {
    let error: unknown
    try {
      sixbWith(types)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OntologyValidationError)
    for (const message of messages) expect(String(error)).toContain(message)
  })

  test("resolves direct, transitive, and parents-declared sub-types", async () => {
    const sixb = sixbWith()

    expect(sixb.objects.listSubTypes("Equipment").sort()).toEqual([
      "AHU",
      "Boiler",
      "HVACEquipment",
    ])
    expect(sixb.objects.listSubTypes("WaterHeater")).toEqual(["Boiler"])
    expect(sixb.objects.listSubTypes("AHU")).toEqual([])
    expect(sixb.objects.listSubTypes("Location")).toEqual([])

    await sixb.objects(Equipment).upsert({ properties: { id: "eq-1", name: "Generic" } })
    await sixb.objects(HVACEquipment).upsert({ properties: { id: "hvac-1", name: "HVAC" } })
    await sixb.objects(AHU).upsert({ properties: { id: "ahu-1", name: "AHU" } })
    await sixb.objects(Boiler).upsert({ properties: { id: "boiler-1", name: "Boiler" } })
    await sixb.objects(WaterHeater).upsert({ properties: { id: "wh-1", name: "Heater" } })

    const listed = async (objectTypeId: string) =>
      (await sixb.objects.list({ objectTypeIds: [objectTypeId] })).objects
        .map((object) => object.primaryId)
        .sort()
    expect(await listed("Equipment")).toEqual(["ahu-1", "boiler-1", "eq-1", "hvac-1"])
    expect(await listed("AHU")).toEqual(["ahu-1"])
    expect(await listed("WaterHeater")).toEqual(["boiler-1", "wh-1"])
  })
})

describe("link target validation", () => {
  const TypeA = defineObjectType({
    id: "TypeA",
    name: "A",
    properties: [prop("id", "string", { required: true, primary: true })],
  })
  const TypeB = defineObjectType({
    id: "TypeB",
    name: "B",
    properties: [prop("id", "string", { required: true, primary: true })],
  })
  const Source = defineObjectType({
    id: "Source",
    name: "Source",
    properties: [prop("id", "string", { required: true, primary: true })],
    links: [
      link.ref("rel", ["TypeA", "TypeB"]),
      link.ref("equipment", ["Equipment"]),
      link.any("anything"),
    ],
  })

  async function seeded() {
    const sixb = sixbWith([Equipment, HVACEquipment, AHU, Location, TypeA, TypeB, Source])
    await sixb.objects.upsert("Equipment", { id: "eq-1", name: "E" })
    await sixb.objects.upsert("HVACEquipment", { id: "hvac-1", name: "H" })
    await sixb.objects.upsert("AHU", { id: "ahu-1", name: "A" })
    await sixb.objects.upsert("Location", { id: "loc-1", address: "A" })
    await sixb.objects.upsert("TypeA", { id: "a-1" })
    await sixb.objects.upsert("TypeB", { id: "b-1" })
    await sixb.objects.upsert("Source", { id: "s-1" })
    return sixb
  }
  // Every row writes a different link or none, so the rows share one seeded runtime.
  let shared: ReturnType<typeof seeded> | undefined
  const runtime = () => {
    shared ??= seeded()
    return shared
  }

  test.each([
    ["the exact target type", "Equipment", "eq-1", "locatedIn", "Location", "loc-1"],
    ["a sub-type of the target", "HVACEquipment", "hvac-1", "feeds", "AHU", "ahu-1"],
    ["the first listed target", "Source", "s-1", "rel", "TypeA", "a-1"],
    ["another listed target", "Source", "s-1", "rel", "TypeB", "b-1"],
    ["a sub-type of a listed target", "Source", "s-1", "equipment", "AHU", "ahu-1"],
    ["any type for a '*' target", "Source", "s-1", "anything", "Location", "loc-1"],
  ])("upsertLink accepts %s", async (_, sourceTypeId, sourceId, linkId, targetTypeId, targetId) => {
    const sixb = await runtime()
    expect(
      await sixb.objects.upsertLink(sourceTypeId, sourceId, linkId, { targetTypeId, targetId })
    ).toBeUndefined()
  })

  test.each([
    "upsertLink",
    "removeLink",
  ] as const)("%s rejects a target type outside the declared target", async (method) => {
    const sixb = await runtime()
    const error = await sixb.objects[method]("HVACEquipment", "hvac-1", "feeds", {
      targetTypeId: "Location",
      targetId: "loc-1",
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OntologyValidationError)
    expect(String(error)).toContain("must target 'Equipment'")
  })
})

describe("upsert with inherited properties", () => {
  test("requires the parent's required properties and accepts them with the child's own", async () => {
    const sixb = sixbWith()

    const error = await sixb
      .objects(HVACEquipment)
      // @ts-expect-error intentionally missing required 'name' property
      .upsert({ properties: { id: "hvac-1", capacity: 100 } })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MaterializationValidationError)
    expect(String(error)).toContain("Missing required property 'name'")

    const result = await sixb.objects(HVACEquipment).upsert({
      properties: { id: "hvac-1", name: "My HVAC", capacity: 100 },
    })
    expect(result.properties).toMatchObject({ name: "My HVAC", capacity: 100 })
  })
})
