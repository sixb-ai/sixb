import { defineObjectType, link, prop } from "../src"

/**
 * Compile-time contract tests for extends inference.
 *
 * This file is intentionally type-only (no runtime `bun:test` cases).
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// ── Simple extends ──────────────────────────────────────────

const Equipment = defineObjectType({
  id: "equipment",
  name: "Equipment",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("manufacturer", "string"),
  ],
  links: [link.ref("locatedIn", "location", { cardinality: "one" })],
})

const HVACEquipment = defineObjectType({
  extends: Equipment,
  id: "hvac",
  name: "HVAC Equipment",
  properties: [prop("capacity", "double")],
  links: [link.ref("feeds", "hvac", { cardinality: "many" })],
})

// ── extends stores parent id as string ──────────────────────
type _extendsId = Expect<Equal<typeof HVACEquipment.extends, "equipment">>
type _noExtends = Expect<Equal<typeof Equipment.extends, undefined>>

// ── Property tokens include inherited ───────────────────────
type _propKeys = Expect<
  Equal<keyof typeof HVACEquipment.p, "id" | "name" | "manufacturer" | "capacity">
>
type _inheritedTokenObjectTypeId = Expect<Equal<typeof HVACEquipment.p.name.objectTypeId, "hvac">>
type _ownTokenObjectTypeId = Expect<Equal<typeof HVACEquipment.p.capacity.objectTypeId, "hvac">>

// ── Link tokens include inherited ───────────────────────────
type _inheritedLinkToken = Expect<Equal<typeof HVACEquipment.l.locatedIn.id, "locatedIn">>
type _ownLinkToken = Expect<Equal<typeof HVACEquipment.l.feeds.id, "feeds">>

// ── Property ids union includes inherited ───────────────────
type _allPropIds = Expect<
  Equal<
    (typeof HVACEquipment.properties)[number]["id"],
    "id" | "name" | "manufacturer" | "capacity"
  >
>

// ── Override: child replaces parent property with same id ───

const Parent = defineObjectType({
  id: "parent",
  name: "Parent",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string"),
    prop("extra", "boolean"),
  ],
})

const Child = defineObjectType({
  extends: Parent,
  id: "child",
  name: "Child",
  properties: [prop("status", "integer")],
})

type _childPropKeys = Expect<Equal<keyof typeof Child.p, "id" | "extra" | "status">>

// ── Multi-level: Entity → Equipment2 → HVACEquipment2 → AHU ──

const Entity = defineObjectType({
  id: "entity",
  name: "Entity",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("entityName", "string", { required: true }),
  ],
  links: [link.ref("partOf", "entity", { cardinality: "one" })],
})

const Equipment2 = defineObjectType({
  extends: Entity,
  id: "equipment2",
  name: "Equipment",
  properties: [prop("serialNumber", "string")],
  links: [link.ref("serves", "entity", { cardinality: "many" })],
})

const HVACEquipment2 = defineObjectType({
  extends: Equipment2,
  id: "hvacEquipment2",
  name: "HVAC Equipment",
  properties: [prop("capacity", "double")],
})

const AHU = defineObjectType({
  extends: HVACEquipment2,
  id: "ahu",
  name: "Air Handling Unit",
  properties: [prop("filterType", "string")],
})

type _ahuPropKeys = Expect<
  Equal<keyof typeof AHU.p, "id" | "entityName" | "serialNumber" | "capacity" | "filterType">
>

type _ahuLinkPartOf = Expect<Equal<typeof AHU.l.partOf.id, "partOf">>
type _ahuLinkServes = Expect<Equal<typeof AHU.l.serves.id, "serves">>
