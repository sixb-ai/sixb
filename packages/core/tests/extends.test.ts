import { describe, expect, test } from "bun:test"
import type { ObjectType } from "../src"
import {
  defineObjectType,
  link,
  MaterializationValidationError,
  OntologyValidationError,
  prop,
  Sixb,
} from "../src"
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

// ── defineObjectType merging ────────────────────────────────

describe("defineObjectType with extends", () => {
  test("stores parent id as extends string", () => {
    expect(HVACEquipment.extends).toBe("Equipment")
    expect(Equipment.extends).toBeUndefined()
  })

  test("merges parent properties into child", () => {
    const propIds = HVACEquipment.properties.map((p) => p.id)
    expect(propIds).toContain("name")
    expect(propIds).toContain("manufacturer")
    expect(propIds).toContain("capacity")
  })

  test("merges parent links into child", () => {
    const linkIds = HVACEquipment.links.map((l) => l.id)
    expect(linkIds).toContain("locatedIn")
    expect(linkIds).toContain("feeds")
  })

  test("property tokens include inherited properties", () => {
    expect(HVACEquipment.p.name).toBeDefined()
    expect(HVACEquipment.p.name.objectTypeId).toBe("HVACEquipment")
    expect(HVACEquipment.p.capacity).toBeDefined()
    expect(HVACEquipment.p.capacity.objectTypeId).toBe("HVACEquipment")
  })

  test("link tokens include inherited links", () => {
    expect(HVACEquipment.l.locatedIn).toBeDefined()
    expect(HVACEquipment.l.locatedIn.objectTypeId).toBe("HVACEquipment")
    expect(HVACEquipment.l.feeds).toBeDefined()
  })

  test("child property overrides parent property with same id", () => {
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

    const statusProp = Child.properties.find((p) => p.id === "status")
    expect(statusProp?.schema).toBe("integer")
    expect(Child.properties).toHaveLength(3) // id (inherited) + extra + status (overridden)
  })

  test("multi-level inheritance: AHU gets all ancestor props/links", () => {
    const propIds = AHU.properties.map((p) => p.id)
    expect(propIds).toContain("name")
    expect(propIds).toContain("manufacturer")
    expect(propIds).toContain("capacity")
    expect(propIds).toContain("filterType")

    const linkIds = AHU.links.map((l) => l.id)
    expect(linkIds).toContain("locatedIn")
    expect(linkIds).toContain("feeds")
  })
})

// ── String extends (pre-flattened, codegen path) ─────────────

describe("defineObjectType with string extends (pre-flattened)", () => {
  const PreFlattened = defineObjectType({
    id: "PreFlattened",
    name: "Pre-Flattened Type",
    extends: "brick:Equipment",
    properties: [prop("inheritedProp", "string"), prop("ownProp", "double", { required: true })],
    links: [link.ref("hasLocation", "brick:Location")],
  })

  test(".extends stores the string directly", () => {
    expect(PreFlattened.extends).toBe("brick:Equipment")
  })

  test("properties are taken as-is (no merge)", () => {
    expect(PreFlattened.properties).toHaveLength(2)
    expect(PreFlattened.properties.map((p) => p.id)).toEqual(["inheritedProp", "ownProp"])
  })

  test("links are taken as-is (no merge)", () => {
    expect(PreFlattened.links).toHaveLength(1)
    expect(PreFlattened.links[0].id).toBe("hasLocation")
  })

  test("parents includes the string extends", () => {
    expect(PreFlattened.parents).toEqual(["brick:Equipment"])
  })

  test("parents includes string extends + additional parents", () => {
    const WithParents = defineObjectType({
      id: "WithParents",
      name: "With Parents",
      extends: "brick:Equipment",
      parents: ["brick:Sensor"],
    })
    expect(WithParents.parents).toEqual(["brick:Equipment", "brick:Sensor"])
  })

  test("property tokens work", () => {
    expect(PreFlattened.p.inheritedProp).toBeDefined()
    expect(PreFlattened.p.ownProp).toBeDefined()
    expect(PreFlattened.p.ownProp.objectTypeId).toBe("PreFlattened")
  })

  test("link tokens work", () => {
    expect(PreFlattened.l.hasLocation).toBeDefined()
    expect(PreFlattened.l.hasLocation.objectTypeId).toBe("PreFlattened")
  })
})

// ── Multi-parent (parents field) ─────────────────────────────

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

describe("defineObjectType with parents (multi-parent)", () => {
  test("parents includes extends parent + additional parents", () => {
    expect(Boiler.parents as string[]).toEqual(["HVACEquipment", "WaterHeater"])
  })

  test("extends is still the structural parent", () => {
    expect(Boiler.extends).toBe("HVACEquipment")
  })

  test("inherits properties from extends parent only", () => {
    const propIds = Boiler.properties.map((p) => p.id)
    expect(propIds).toContain("name") // from Equipment via HVACEquipment
    expect(propIds).toContain("capacity") // from HVACEquipment
  })

  test("parents without extends stores as-is", () => {
    const Standalone = defineObjectType({
      id: "Standalone",
      name: "Standalone",
      properties: [prop("id", "string", { required: true, primary: true })],
      parents: ["SomeParent"],
    })
    expect(Standalone.parents).toEqual(["SomeParent"])
    expect(Standalone.extends).toBeUndefined()
  })

  test("parents deduplicates extends parent if also listed", () => {
    const Dedup = defineObjectType({
      extends: Equipment,
      id: "Dedup",
      name: "Dedup",
      parents: ["Equipment", "WaterHeater"],
    })
    expect(Dedup.parents).toEqual(["Equipment", "WaterHeater"])
  })
})

// ── Sixb runtime validation ────────────────────────────────

describe("Sixb extends validation", () => {
  test("constructs successfully with valid extends chain", () => {
    expect(() => {
      new Sixb({
        ontology: [Equipment, HVACEquipment, AHU, Location],
        ...createTestRuntimeDeps(),
      })
    }).not.toThrow()
  })

  test("throws when extends references unknown type", () => {
    const Orphan = defineObjectType({
      extends: { id: "nonexistent", properties: [], links: [] },
      id: "Orphan",
      name: "Orphan",
    })

    expect(() => {
      new Sixb({
        ontology: [Orphan],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(OntologyValidationError)
    expect(() => {
      new Sixb({
        ontology: [Orphan],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('extends unknown type "nonexistent"')
    // Verify the hint message mentions 'ontologies'
  })

  test("error message hints at ontologies option", () => {
    const Orphan = defineObjectType({
      extends: { id: "nonexistent", properties: [], links: [] },
      id: "Orphan2",
      name: "Orphan2",
    })

    expect(() => {
      new Sixb({
        ontology: [Orphan],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(OntologyValidationError)
    expect(() => {
      new Sixb({
        ontology: [Orphan],
        ...createTestRuntimeDeps(),
      })
    }).toThrow("add it to 'ontologies' in createSixb()")
  })

  test("throws on circular extends chain", () => {
    // A real cycle (A extends B extends A) can't be created via defineObjectType()
    // because the parent must exist at call time. We use literal objects to simulate
    // what would happen if two types reference each other's id in the registry.
    const A = defineObjectType({
      id: "CycleA",
      name: "A",
      extends: { id: "CycleB", properties: [], links: [] },
    })

    const B = defineObjectType({
      id: "CycleB",
      name: "B",
      extends: { id: "CycleA", properties: [], links: [] },
    })

    expect(() => {
      new Sixb({
        ontology: [A, B],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(OntologyValidationError)
    expect(() => {
      new Sixb({
        ontology: [A, B],
        ...createTestRuntimeDeps(),
      })
    }).toThrow("Circular extends chain detected")
  })
})

// ── listSubTypes ─────────────────────────────────────────────

describe("listSubTypes", () => {
  test("returns direct and transitive sub-types", () => {
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...createTestRuntimeDeps(),
    })

    const subTypes = sixb.objects.listSubTypes("Equipment")
    expect(subTypes).toContain("HVACEquipment")
    expect(subTypes).toContain("AHU")
    expect(subTypes).not.toContain("Location")
  })

  test("returns empty array for leaf types", () => {
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.objects.listSubTypes("AHU")).toEqual([])
    expect(sixb.objects.listSubTypes("Location")).toEqual([])
  })
})

// ── Subclass-aware list ─────────────────────────────────────

describe("subclass-aware list", () => {
  test("listing by parent type includes sub-type objects", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...runtimeDeps,
    })

    await sixb.objects(Equipment).upsert({ properties: { id: "eq-1", name: "Generic Equip" } })
    await sixb.objects(HVACEquipment).upsert({ properties: { id: "hvac-1", name: "HVAC Unit" } })
    await sixb.objects(AHU).upsert({ properties: { id: "ahu-1", name: "AHU Unit" } })

    const result = await sixb.objects.list({ objectTypeIds: ["Equipment"] })

    const ids = result.objects.map((o) => o.primaryId)
    expect(ids).toContain("eq-1")
    expect(ids).toContain("hvac-1")
    expect(ids).toContain("ahu-1")
    expect(result.objects).toHaveLength(3)
  })

  test("listing by leaf type returns only that type", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...runtimeDeps,
    })

    await sixb.objects(Equipment).upsert({ properties: { id: "eq-1", name: "Generic" } })
    await sixb.objects(AHU).upsert({ properties: { id: "ahu-1", name: "AHU" } })

    const result = await sixb.objects.list({ objectTypeIds: ["AHU"] })
    expect(result.objects).toHaveLength(1)
    expect(result.objects[0].primaryId).toBe("ahu-1")
  })
})

// ── Multi-parent subtype queries ─────────────────────────────

describe("multi-parent subtype queries", () => {
  test("listSubTypes includes types registered via parents", () => {
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location, WaterHeater, Boiler],
      ...createTestRuntimeDeps(),
    })

    const waterHeaterSubs = sixb.objects.listSubTypes("WaterHeater")
    expect(waterHeaterSubs).toContain("Boiler")

    // Also a sub-type of HVACEquipment via extends
    const hvacSubs = sixb.objects.listSubTypes("HVACEquipment")
    expect(hvacSubs).toContain("Boiler")
  })

  test("listing by additional parent includes the type", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location, WaterHeater, Boiler],
      ...runtimeDeps,
    })

    await sixb.objects(Boiler).upsert({ properties: { id: "boiler-1", name: "Main Boiler" } })
    await sixb.objects(WaterHeater).upsert({
      properties: { id: "wh-1", name: "Basic Heater" },
    })

    const result = await sixb.objects.list({ objectTypeIds: ["WaterHeater"] })
    const ids = result.objects.map((o) => o.primaryId)
    expect(ids).toContain("wh-1")
    expect(ids).toContain("boiler-1")
  })

  test("throws when parents references unknown type", () => {
    const BadParent = defineObjectType({
      id: "BadParent",
      name: "Bad",
      properties: [prop("id", "string", { required: true, primary: true })],
      parents: ["nonexistent"],
    })

    expect(() => {
      new Sixb({
        ontology: [BadParent],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(OntologyValidationError)
    expect(() => {
      new Sixb({
        ontology: [BadParent],
        ...createTestRuntimeDeps(),
      })
    }).toThrow('lists unknown parent "nonexistent" in parents')
    // Verify the hint message mentions 'ontologies'
  })

  test("parents error message hints at ontologies option", () => {
    const BadParent2 = defineObjectType({
      id: "BadParent2",
      name: "Bad2",
      properties: [prop("id", "string", { required: true, primary: true })],
      parents: ["nonexistent2"],
    })

    expect(() => {
      new Sixb({
        ontology: [BadParent2],
        ...createTestRuntimeDeps(),
      })
    }).toThrow(OntologyValidationError)
    expect(() => {
      new Sixb({
        ontology: [BadParent2],
        ...createTestRuntimeDeps(),
      })
    }).toThrow("add it to 'ontologies' in createSixb()")
  })
})

// ── quantityKind ─────────────────────────────────────────────

describe("quantityKind", () => {
  test("quantityKind is preserved on the type", () => {
    const TempSensor = defineObjectType({
      id: "TempSensor",
      name: "Temperature Sensor",
      properties: [prop("id", "string", { required: true, primary: true })],
      quantityKind: "Temperature",
    })
    expect(TempSensor.quantityKind).toBe("Temperature")
  })

  test("seeAlso is preserved on the type", () => {
    const Building = defineObjectType({
      id: "Building",
      name: "Building",
      properties: [prop("id", "string", { required: true, primary: true })],
      seeAlso: ["https://example.com/docs"],
    })
    expect(Building.seeAlso).toEqual(["https://example.com/docs"])
  })

  test("seeAlso is undefined when not provided", () => {
    expect((Equipment as ObjectType).seeAlso).toBeUndefined()
  })

  test("quantityKind is undefined when not provided", () => {
    expect((Equipment as ObjectType).quantityKind).toBeUndefined()
  })

  test("child can specify its own quantityKind", () => {
    const Sensor = defineObjectType({
      id: "Sensor",
      name: "Sensor",
      properties: [prop("id", "string", { required: true, primary: true })],
    })

    const CO2Sensor = defineObjectType({
      extends: Sensor,
      id: "CO2Sensor",
      name: "CO2 Sensor",
      quantityKind: "Concentration",
    })

    expect(CO2Sensor.quantityKind).toBe("Concentration")
    expect((Sensor as ObjectType).quantityKind).toBeUndefined()
  })
})

// ── Link target validation (string, string[], "*", subtypes) ──

describe("link target validation", () => {
  test("upsertLink with string target: accepts exact match", async () => {
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects.upsert("Equipment", { id: "eq-1", name: "E" })
    await sixb.objects.upsert("Location", { id: "loc-1", address: "A" })

    // Equipment has link "locatedIn" targeting "Location" — exact match
    await expect(
      sixb.objects.upsertLink("Equipment", "eq-1", "locatedIn", {
        targetTypeId: "Location",
        targetId: "loc-1",
      })
    ).resolves.toBeUndefined()
  })

  test("upsertLink with string target: accepts sub-type", async () => {
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects.upsert("HVACEquipment", { id: "hvac-1", name: "H" })
    await sixb.objects.upsert("AHU", { id: "ahu-1", name: "A" })

    // HVACEquipment has link "feeds" targeting "Equipment" — AHU is sub-type of Equipment
    await expect(
      sixb.objects.upsertLink("HVACEquipment", "hvac-1", "feeds", {
        targetTypeId: "AHU",
        targetId: "ahu-1",
      })
    ).resolves.toBeUndefined()
  })

  test("upsertLink with string target: rejects unrelated type", async () => {
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects.upsert("HVACEquipment", { id: "hvac-1", name: "H" })
    await sixb.objects.upsert("Location", { id: "loc-1", address: "A" })

    // HVACEquipment.feeds targets Equipment — Location is not a sub-type
    await expect(
      sixb.objects.upsertLink("HVACEquipment", "hvac-1", "feeds", {
        targetTypeId: "Location",
        targetId: "loc-1",
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      sixb.objects.upsertLink("HVACEquipment", "hvac-1", "feeds", {
        targetTypeId: "Location",
        targetId: "loc-1",
      })
    ).rejects.toThrow("must target 'Equipment'")
  })

  test("upsertLink with string[] target: accepts any listed type", async () => {
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
      links: [link.ref("rel", ["TypeA", "TypeB"])],
    })

    const sixb = new Sixb({
      ontology: [TypeA, TypeB, Source],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects.upsert("Source", { id: "s-1" })
    await sixb.objects.upsert("TypeA", { id: "a-1" })
    await sixb.objects.upsert("TypeB", { id: "b-1" })

    await expect(
      sixb.objects.upsertLink("Source", "s-1", "rel", {
        targetTypeId: "TypeA",
        targetId: "a-1",
      })
    ).resolves.toBeUndefined()

    await expect(
      sixb.objects.upsertLink("Source", "s-1", "rel", {
        targetTypeId: "TypeB",
        targetId: "b-1",
      })
    ).resolves.toBeUndefined()
  })

  test("upsertLink with string[] target: accepts sub-type of any listed type", async () => {
    const Source = defineObjectType({
      id: "Src",
      name: "Src",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link.ref("rel", ["Equipment"])],
    })

    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location, Source],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects.upsert("Src", { id: "s-1" })
    await sixb.objects.upsert("AHU", { id: "ahu-1", name: "A" })

    // AHU is sub-type of Equipment
    await expect(
      sixb.objects.upsertLink("Src", "s-1", "rel", {
        targetTypeId: "AHU",
        targetId: "ahu-1",
      })
    ).resolves.toBeUndefined()
  })

  test("upsertLink with '*' target: accepts any type", async () => {
    const Source = defineObjectType({
      id: "WildSrc",
      name: "WildSrc",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link.any("anything")],
    })

    const sixb = new Sixb({
      ontology: [Equipment, Location, Source],
      ...createTestRuntimeDeps(),
    })

    await sixb.objects.upsert("WildSrc", { id: "s-1" })
    await sixb.objects.upsert("Location", { id: "loc-1", address: "A" })

    await expect(
      sixb.objects.upsertLink("WildSrc", "s-1", "anything", {
        targetTypeId: "Location",
        targetId: "loc-1",
      })
    ).resolves.toBeUndefined()
  })

  test("removeLink with string target: rejects unrelated type", async () => {
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...createTestRuntimeDeps(),
    })

    await expect(
      sixb.objects.removeLink("HVACEquipment", "hvac-1", "feeds", {
        targetTypeId: "Location",
        targetId: "loc-1",
      })
    ).rejects.toBeInstanceOf(OntologyValidationError)
    await expect(
      sixb.objects.removeLink("HVACEquipment", "hvac-1", "feeds", {
        targetTypeId: "Location",
        targetId: "loc-1",
      })
    ).rejects.toThrow("must target 'Equipment'")
  })
})

// ── Upsert with inherited validation ────────────────────────

describe("upsert with inherited properties", () => {
  test("validates required properties from parent", async () => {
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...createTestRuntimeDeps(),
    })

    // HVACEquipment inherits required `name` from Equipment
    await expect(
      sixb.objects(HVACEquipment).upsert({
        // @ts-expect-error intentionally missing required 'name' property
        properties: { id: "hvac-1", capacity: 100 },
      })
    ).rejects.toBeInstanceOf(MaterializationValidationError)
    await expect(
      sixb.objects(HVACEquipment).upsert({
        // @ts-expect-error intentionally missing required 'name' property
        properties: { id: "hvac-1", capacity: 100 },
      })
    ).rejects.toThrow("Missing required property 'name'")
  })

  test("accepts inherited + own properties together", async () => {
    const sixb = new Sixb({
      ontology: [Equipment, HVACEquipment, AHU, Location],
      ...createTestRuntimeDeps(),
    })

    const result = await sixb.objects(HVACEquipment).upsert({
      properties: { id: "hvac-1", name: "My HVAC", capacity: 100 },
    })

    expect(result.properties.name).toBe("My HVAC")
    expect(result.properties.capacity).toBe(100)
  })
})
