import {
  type DecimalValue,
  decimal,
  defineObjectType,
  defineValueType,
  type FileRef,
  type InferObjectProperties,
  type InferPropertyUnit,
  type InferPropertyValue,
  type InferSchema,
  type InferTelemetryPropertyIds,
  prop,
  type UnitsOf,
  valueTypeRef,
} from "../src"

/**
 * Compile-time contract tests for schema/value/unit inference.
 *
 * This file is intentionally type-only so `tsc --noEmit` enforces the SDK DX.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const temperatureReading = defineValueType({
  id: "temperatureReading",
  name: "Temperature Reading",
  schema: "double",
  semanticType: "Temperature",
})

const room = defineObjectType({
  id: "room",
  name: "Room",
  properties: [
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
    prop("displayName", "string"),
    prop("nickname", "string", { nullable: true }),
    prop(
      "currentTemperature",
      { type: "valueTypeRef", valueTypeId: "temperatureReading" },
      {
        mode: "telemetry",
      }
    ),
  ],
})

type RoomProperties = InferObjectProperties<typeof room, [typeof temperatureReading]>

const validRoom: RoomProperties = {
  externalId: "RM-101",
  name: "Conference 101",
  currentTemperature: 22.4,
}

const validNullableRoom: RoomProperties = {
  externalId: "RM-102",
  name: "Conference 102",
  nickname: null,
}

const invalidRoomUnknownProperty: RoomProperties = {
  externalId: "RM-103",
  name: "Conference 103",
  // @ts-expect-error Room has no manufacturer property
  manufacturer: "Acme",
}

// @ts-expect-error externalId is required
const invalidRoomRequiredProperty: RoomProperties = {
  name: "Conference 104",
}

type RoomTelemetryIds = InferTelemetryPropertyIds<typeof room>
type _telemetryIds = Expect<Equal<RoomTelemetryIds, "currentTemperature">>

type CurrentTemperatureProperty = Extract<
  (typeof room.properties)[number],
  { id: "currentTemperature" }
>

type CurrentTemperatureValue = InferPropertyValue<
  CurrentTemperatureProperty,
  [typeof temperatureReading]
>
type _currentTemperatureValue = Expect<Equal<CurrentTemperatureValue, number>>

type CurrentTemperatureUnit = InferPropertyUnit<
  CurrentTemperatureProperty,
  [typeof temperatureReading]
>
type _currentTemperatureUnit = Expect<Equal<CurrentTemperatureUnit, UnitsOf<"Temperature">>>
type _fileRefSchema = Expect<Equal<InferSchema<"fileRef">, FileRef>>
type _decimalSchema = Expect<Equal<InferSchema<"decimal">, DecimalValue>>

const exactAmount: InferSchema<"decimal"> = decimal("9007199254740993.01")
// @ts-expect-error Decimal ontology values must be constructed from exact strings or bigints.
const impreciseAmount: InferSchema<"decimal"> = 9_007_199_254_740_994
// @ts-expect-error Ordinary strings are not branded exact decimal values.
const unbrandedAmount: InferSchema<"decimal"> = "9007199254740993.01"

const validTelemetryAppend: {
  value: CurrentTemperatureValue
  unit: CurrentTemperatureUnit
  at: Date
} = {
  value: 22.4,
  unit: "degreeCelsius",
  at: new Date(),
}

const invalidTelemetryValue: {
  value: CurrentTemperatureValue
  unit: CurrentTemperatureUnit
  at: Date
} = {
  // @ts-expect-error currentTemperature expects a numeric value
  value: "hot",
  unit: "degreeCelsius",
  at: new Date(),
}

const invalidTelemetryUnit: {
  value: CurrentTemperatureValue
  unit: CurrentTemperatureUnit
  at: Date
} = {
  value: 22.4,
  // @ts-expect-error Temperature cannot use pressure units
  unit: "millibar",
  at: new Date(),
}

// ── valueTypeRef(ValueType) — self-contained, no tuple needed ──
const areaShape = defineValueType({
  id: "areaShape",
  name: "Area",
  schema: {
    type: "object",
    properties: {
      value: { schema: "double", required: true },
      hasUnit: {
        schema: { type: "enum", valueType: "string", values: ["m2", "ft2"] },
        required: true,
      },
    },
  },
} as const)

const building = defineObjectType({
  id: "building",
  name: "Building",
  properties: [prop("area", valueTypeRef(areaShape))],
})

type BuildingProps = InferObjectProperties<typeof building> // no TValueTypes!
type _areaType = Expect<
  Equal<NonNullable<BuildingProps["area"]>, { value: number; hasUnit: "m2" | "ft2" }>
>

// ── valueTypeRef(string, schema) — escape hatch ──
const buildingAlt = defineObjectType({
  id: "buildingAlt",
  name: "Building Alt",
  properties: [prop("area", valueTypeRef("areaShape", areaShape.schema))],
})

type BuildingAltProps = InferObjectProperties<typeof buildingAlt>
type _areaAltType = Expect<
  Equal<NonNullable<BuildingAltProps["area"]>, { value: number; hasUnit: "m2" | "ft2" }>
>

// ── valueTypeRef(string) — fallback to tuple lookup still works ──
const buildingLegacy = defineObjectType({
  id: "buildingLegacy",
  name: "Building Legacy",
  properties: [
    prop("currentTemperature", valueTypeRef("temperatureReading"), { mode: "telemetry" }),
  ],
})

type BuildingLegacyProps = InferObjectProperties<typeof buildingLegacy, [typeof temperatureReading]>
type _legacyTempType = Expect<Equal<NonNullable<BuildingLegacyProps["currentTemperature"]>, number>>

const invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true }),
    prop("pdf", "fileRef"),
    prop("photos", { type: "array", items: "fileRef" }),
  ],
})

type InvoiceProps = InferObjectProperties<typeof invoice>
type _invoicePdfType = Expect<Equal<NonNullable<InvoiceProps["pdf"]>, FileRef>>
type _invoicePhotosType = Expect<Equal<NonNullable<InvoiceProps["photos"]>, FileRef[]>>

void validRoom
void validNullableRoom
void invalidRoomUnknownProperty
void invalidRoomRequiredProperty
void validTelemetryAppend
void invalidTelemetryValue
void invalidTelemetryUnit
void exactAmount
void impreciseAmount
void unbrandedAmount
