import { defineObjectType, integerEnum, link, prop, stringEnum } from "../src"

/**
 * Compile-time contract tests for builder literal inference.
 *
 * This file is intentionally type-only (no runtime `bun:test` cases).
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const hvacMode = stringEnum(["off", "heat", "cool", "auto"])
type _hvacModeValues = Expect<
  Equal<(typeof hvacMode)["values"][number], "off" | "heat" | "cool" | "auto">
>

const fanSpeeds = integerEnum([1, 2, 3, 4])
type _fanSpeedValues = Expect<Equal<(typeof fanSpeeds)["values"][number], 1 | 2 | 3 | 4>>

const manufacturer = prop("manufacturer", "string", { name: "Manufacturer", required: true })
type _manufacturerId = Expect<Equal<typeof manufacturer.id, "manufacturer">>
type _manufacturerName = Expect<Equal<typeof manufacturer.name, "Manufacturer">>

const nickname = prop("nickname", "string", { nullable: true })
type _nicknameNullable = Expect<Equal<typeof nickname.nullable, true>>

const telemetryReading = prop("currentTemperature", "double", { mode: "telemetry" })
type _telemetryMode = Expect<Equal<typeof telemetryReading.mode, "telemetry">>

const primaryProp = prop("externalId", "string", { primary: true })
type _primaryTrue = Expect<Equal<typeof primaryProp.primary, true>>

const nonPrimaryProp = prop("serialNumber", "string")
type _primaryAbsent = Expect<Equal<typeof nonPrimaryProp.primary, true | undefined>>

const primaryRequired = prop("externalId", "string", { primary: true, required: true })
type _primaryRequiredPrimary = Expect<Equal<typeof primaryRequired.primary, true>>
type _primaryRequiredRequired = Expect<Equal<typeof primaryRequired.required, true>>

const searchableName = prop("name", "string", {
  query: { searchable: true, text: true, weight: 4 },
})
type _querySearchable = Expect<Equal<typeof searchableName.query.searchable, true>>
type _queryText = Expect<Equal<typeof searchableName.query.text, true>>
type _queryWeight = Expect<Equal<typeof searchableName.query.weight, 4>>

const thermostat = defineObjectType({
  id: "thermostat",
  name: "Thermostat",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("mode", stringEnum(["off", "heat", "cool", "auto"]), { required: true }),
    prop("fanSpeed", integerEnum([1, 2, 3, 4])),
  ],
  links: [link("locatedIn", "room", { cardinality: "one" })],
  search: {
    title: "externalId",
    defaultText: ["externalId"],
    exact: ["id", "externalId"],
  },
})

type _thermostatId = Expect<Equal<typeof thermostat.id, "thermostat">>
type _thermostatName = Expect<Equal<typeof thermostat.name, "Thermostat">>
type _propertyIds = Expect<
  Equal<(typeof thermostat.properties)[number]["id"], "id" | "externalId" | "mode" | "fanSpeed">
>
type _linkIds = Expect<Equal<(typeof thermostat.links)[number]["id"], "locatedIn">>
type _linkTarget = Expect<Equal<(typeof thermostat.links)[number]["targetObjectTypeId"], "room">>
type _propertyTokenIds = Expect<
  Equal<keyof typeof thermostat.p, "id" | "externalId" | "mode" | "fanSpeed">
>
type _modeTokenId = Expect<Equal<typeof thermostat.p.mode.id, "mode">>
type _linkTokenId = Expect<Equal<typeof thermostat.l.locatedIn.id, "locatedIn">>
type _linkTokenTarget = Expect<Equal<typeof thermostat.l.locatedIn.targetObjectTypeId, "room">>
type _searchTitle = Expect<Equal<typeof thermostat.search.title, "externalId">>
type _searchDefaultText = Expect<
  Equal<(typeof thermostat.search.defaultText)[number], "externalId">
>
type _searchExact = Expect<Equal<(typeof thermostat.search.exact)[number], "id" | "externalId">>

type ModeProperty = Extract<(typeof thermostat.properties)[number], { id: "mode" }>
type _modeEnumUnion = Expect<
  Equal<
    ModeProperty["schema"] extends { values: readonly (infer TValue)[] } ? TValue : never,
    "off" | "heat" | "cool" | "auto"
  >
>

// ── link() overload type tests ─────────────────────────────

// Wildcard: no target → "*"
const wildcardLink = link("anything")
type _wildcardTarget = Expect<Equal<typeof wildcardLink.targetObjectTypeId, "*">>

// Wildcard with options
const wildcardWithOptions = link("anything", { cardinality: "many" })
type _wildcardOptsTarget = Expect<Equal<typeof wildcardWithOptions.targetObjectTypeId, "*">>
type _wildcardOptsCardinality = Expect<Equal<typeof wildcardWithOptions.cardinality, "many">>

// ObjectType target — extracts .id literal
const _Room = defineObjectType({
  id: "room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const objectTypeLink = link("locatedIn", _Room)
type _otLinkTarget = Expect<Equal<typeof objectTypeLink.targetObjectTypeId, "room">>

// ObjectType target + options
const objectTypeLinkWithOpts = link("locatedIn", _Room, { cardinality: "one" })
type _otLinkOptsTarget = Expect<Equal<typeof objectTypeLinkWithOpts.targetObjectTypeId, "room">>
type _otLinkOptsCardinality = Expect<Equal<typeof objectTypeLinkWithOpts.cardinality, "one">>

// ObjectType array target
const _Floor = defineObjectType({
  id: "floor",
  name: "Floor",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const objectTypeArrayLink = link("locatedIn", [_Room, _Floor])
type _otArrayTarget = Expect<
  Equal<typeof objectTypeArrayLink.targetObjectTypeId, ("room" | "floor")[]>
>

// String target (backward compat)
const stringLink = link("locatedIn", "space")
type _stringTarget = Expect<Equal<typeof stringLink.targetObjectTypeId, "space">>

// String array target (backward compat)
const stringArrayLink = link("controls", ["a", "b"] as const)
type _stringArrayTarget = Expect<
  Equal<typeof stringArrayLink.targetObjectTypeId, readonly ["a", "b"]>
>

// Explicit wildcard string (backward compat)
const explicitWildcard = link("anything", "*")
type _explicitWildcardTarget = Expect<Equal<typeof explicitWildcard.targetObjectTypeId, "*">>
