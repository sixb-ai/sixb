import {
  defineObjectType,
  defineValueType,
  type InferPropertyUnit,
  prop,
  type UnitsOf,
  valueTypeRef,
} from "../src"
import type { TelemetryChannel } from "../src/runtime/types"

/**
 * Regression for unitless telemetry (reproduced with TypeScript 5.9.3).
 * Remove the `never` guard in InferPropertyUnit, then run
 * `bun --filter @sixb/core typecheck`: the unitless assertions and writes fail,
 * and the expect-error checks for fabricated units become unused.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const reading = defineValueType({ id: "reading", name: "Reading", schema: "double" })
const temperature = defineValueType({
  id: "temperature",
  name: "Temperature",
  schema: "double",
  semanticType: "Temperature",
})
const device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("count", "integer", { mode: "telemetry" }),
    prop("active", "boolean", { mode: "telemetry" }),
    prop("reading", valueTypeRef(reading), { mode: "telemetry" }),
    prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
    prop("referencedTemperature", valueTypeRef(temperature), { mode: "telemetry" }),
  ],
})
type ValueTypes = [typeof reading, typeof temperature]

type _countUnit = Expect<Equal<InferPropertyUnit<typeof device.p.count.property>, never>>
type _activeUnit = Expect<Equal<InferPropertyUnit<typeof device.p.active.property>, never>>
type _readingUnit = Expect<
  Equal<InferPropertyUnit<typeof device.p.reading.property, ValueTypes>, never>
>
type _temperatureUnit = Expect<
  Equal<InferPropertyUnit<typeof device.p.temperature.property>, UnitsOf<"Temperature">>
>
type _referencedTemperatureUnit = Expect<
  Equal<
    InferPropertyUnit<typeof device.p.referencedTemperature.property, ValueTypes>,
    UnitsOf<"Temperature">
  >
>

// Channels resolve value types through the generated registry, which this program leaves empty.
// A semantic type reached through a referenced value type is covered where one is registered:
// `packages/client/tests/type-programs/ontology-registry/telemetry-units.ts`.
declare const count: TelemetryChannel<typeof device.p.count>
declare const active: TelemetryChannel<typeof device.p.active>
declare const plainReading: TelemetryChannel<typeof device.p.reading>
declare const directTemperature: TelemetryChannel<typeof device.p.temperature>

async function contract(): Promise<void> {
  const at = new Date("2026-01-01T00:00:00Z")
  await count.append({ value: 1, at })
  await active.append({ value: true, at })
  await plainReading.append({ value: 1.5, at })
  // @ts-expect-error Unitless telemetry cannot accept a fabricated string unit.
  await count.append({ value: 1, at, unit: "fake" })
  // @ts-expect-error Unit inference must not admit numeric property keys.
  await count.append({ value: 1, at, unit: 42 })
  // @ts-expect-error Unit inference must not admit symbol property keys.
  await count.append({ value: 1, at, unit: Symbol("unit") })
  // @ts-expect-error A resolved unitless value type also disallows units.
  await plainReading.append({ value: 1.5, at, unit: "degreeCelsius" })
  // @ts-expect-error Unitless telemetry still validates the value's type.
  await active.append({ value: "true", at })

  await directTemperature.append({ value: 20, at, unit: "degreeCelsius" })
  // @ts-expect-error A direct semantic type requires a unit.
  await directTemperature.append({ value: 20, at })
  // @ts-expect-error Temperature cannot use pressure units.
  await directTemperature.append({ value: 20, at, unit: "millibar" })

  const points = await count.history()
  type _historyUnit = Expect<Equal<(typeof points)[number]["unit"], undefined>>
  const temperaturePoints = await directTemperature.history()
  type _temperatureHistoryUnit = Expect<
    Equal<(typeof temperaturePoints)[number]["unit"], UnitsOf<"Temperature"> | undefined>
  >
}

void contract
