# Units & Semantics

A numeric [property](./properties.md) can declare the physical quantity it
measures with `semanticType`. Once set, every telemetry value appended to that
property must carry a `unit` that belongs to the quantity — Sixb validates this
at append time and rejects mismatches.

```ts
import { defineObjectType, prop } from "@sixb/core"

export const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("temperature", "double", {
      mode: "telemetry",
      semanticType: "Temperature",
    }),
  ],
})
```

## semanticType

`semanticType` is an option on `prop(...)` whose value is a quantitative type id
(e.g. `"Temperature"`, `"Pressure"`, `"Power"`). It only makes sense on numeric
schemas — `"double"`, `"integer"`, or `"decimal"`.

| Aspect | Detail |
| --- | --- |
| Where | `prop(id, schema, { semanticType })`, an `ObjectFieldSchema`, or a [value type](./value-types.md) |
| Type | A `QuantitativeTypeId` from the catalog below |
| Effect | Constrains which `unit` strings are valid for telemetry on the property |
| Inheritance | A property referencing a value type inherits that value type's `semanticType` |

Declare it once on a shared value type to keep many properties consistent:

```ts
import { defineValueType } from "@sixb/core"

export const TemperatureReading = defineValueType({
  id: "temperatureReading",
  name: "Temperature Reading",
  schema: "double",
  semanticType: "Temperature",
})
```

Properties that reference `temperatureReading` then inherit the `Temperature`
constraint automatically.

## How units validate telemetry

When you append [telemetry](../objects/telemetry.md), pass the reading's `unit`.
Sixb resolves the property's semantic type (from the property or its value type)
and checks the unit against the quantity's catalog before writing.

```ts
await sixb
  .objects(Sensor)
  .byId("sensor-1")
  .telemetry(Sensor.p.temperature)
  .append({ value: 21.5, unit: "degreeCelsius", at: new Date() })
```

The validation rules are:

| Property state | `unit` provided | Result |
| --- | --- | --- |
| Has `semanticType` | Valid unit for that quantity | Accepted |
| Has `semanticType` | Invalid unit for that quantity | Throws `Invalid unit '…'` |
| Has `semanticType` | Missing | Throws `Missing unit for telemetry property …` |
| No `semanticType` | Any unit | Throws — the property cannot accept a unit |
| No `semanticType` | Missing | Accepted (unitless) |

Errors are `[Sixb]`-prefixed and name the property path and quantity, e.g.
`[Sixb] Invalid unit 'millibar' for Sensor.temperature (Temperature)`.

## The quantitative types catalog

The registry lives in `@sixb/core` and is keyed by semantic type id. Each entry
names a physical quantity and lists its valid units (each unit has a `name` and
display `symbol`). The full set of quantitative type ids:

| Quantitative type id | Measures |
| --- | --- |
| `Acceleration` | Rate of change of velocity |
| `Angle` | Measure of rotation between two rays |
| `AngularAcceleration` | Rate of change of angular velocity |
| `AngularVelocity` | Rate of rotation around an axis |
| `ApparentEnergy` | Integral of apparent power over time |
| `ApparentPower` | RMS voltage × RMS current in an AC circuit |
| `Area` | Extent of a two-dimensional surface |
| `Capacitance` | Ability to store an electric charge |
| `Concentration` | Amount of substance per unit volume/mass |
| `Current` | Flow of electric charge |
| `DataRate` | Data transferred per unit time |
| `DataSize` | Amount of digital information |
| `Density` | Mass per unit volume |
| `Distance` | How far apart two points are |
| `ElectricCharge` | Quantity of electric charge |
| `Energy` | Capacity to do work |
| `EnergyRate` | Rate of energy transfer or conversion |
| `Force` | Interaction that changes an object's motion |
| `Frequency` | Occurrences per unit time |
| `Humidity` | Absolute moisture content (mass per volume) |
| `Illuminance` | Luminous flux on a surface per area |
| `Inductance` | Opposition to change in current |
| `IonizingRadiationDose` | Absorbed dose of ionizing radiation |
| `Irradiance` | EM radiation power per unit area |
| `Latitude` | Angular distance north/south of the equator |
| `Length` | One-dimensional extent |
| `Longitude` | Angular distance east/west of the prime meridian |
| `Luminance` | Luminous intensity per unit area |
| `Luminosity` | EM energy emitted per unit time |
| `LuminousFlux` | Total visible light emitted by a source |
| `LuminousIntensity` | Luminous flux per unit solid angle |
| `MagneticFlux` | Total magnetic field through an area |
| `MagneticInduction` | Magnetic flux density |
| `Mass` | Quantity of matter |
| `MassFlowRate` | Mass passing a point per unit time |
| `Power` | Rate of energy transfer or work |
| `Pressure` | Force applied per unit area |
| `Radioactivity` | Rate of radioactive decay |
| `ReactiveEnergy` | Integral of reactive power over time |
| `ReactivePower` | Power oscillating between source and load |
| `RelativeDensity` | Density relative to a reference substance |
| `RelativeHumidity` | Current moisture vs. saturation capacity |
| `Resistance` | Opposition to flow of electric current |
| `SoundPressure` | Local pressure deviation caused by sound |
| `Temperature` | Degree of hotness or coldness |
| `Thrust` | Reaction force from expelling mass |
| `TimeSpan` | Duration of time (numeric) |
| `Torque` | Rotational force |
| `Velocity` | Speed in a given direction |
| `Voltage` | Electric potential difference |
| `Volume` | Extent of a three-dimensional space |
| `VolumeFlowRate` | Volume of fluid passing a point per unit time |

A few example unit sets:

| Quantity | Unit ids |
| --- | --- |
| `Temperature` | `degreeCelsius`, `degreeFahrenheit`, `kelvin` |
| `Pressure` | `bar`, `pascal`, `kilopascal`, `millibar`, `psi`, `inchesOfMercury`, … |
| `Power` | `watt`, `kilowatt`, `megawatt`, `horsepower`, `britishThermalUnitPerHour`, … |
| `Energy` | `joule`, `kilojoule`, `wattHour`, `kilowattHour`, `britishThermalUnit`, … |

There is no `Currency` quantity and no money units — only the physical
quantities above are valid `semanticType` values.

## Units API

These helpers and types are exported from `@sixb/core` for browsing and
validating units at runtime:

| Export | Signature | Returns |
| --- | --- | --- |
| `quantitativeTypes` | const registry | The full catalog, keyed by quantitative type id |
| `getUnit(unitId)` | `(string)` | The unit (`name`, `symbol`) plus its `quantitativeTypeId`, or `undefined` |
| `getUnitsFor(qtId)` | `(string)` | The `Record<string, Unit>` of valid units, or `undefined` |
| `isValidUnit(qtId, unitId)` | `(string, string)` | `boolean` — is the unit valid for the quantity |
| `getUnitSymbol(unitId)` | `(string)` | The display symbol, or `undefined` |
| `isQuantitativeTypeId(value)` | `(string)` | Type guard for `QuantitativeTypeId` |
| `isUnitId(value)` | `(string)` | Type guard for `UnitId` |

Type-level helpers: `QuantitativeTypeId`, `UnitId`, and `UnitsOf<Q>` (the unit id
union for one quantity).

```ts
import {
  quantitativeTypes,
  getUnit,
  isValidUnit,
  getUnitSymbol,
} from "@sixb/core"

quantitativeTypes.Temperature.units.degreeCelsius.symbol // "°C"

isValidUnit("Temperature", "degreeCelsius") // true
isValidUnit("Temperature", "millibar")      // false

getUnitSymbol("kilowattHour") // "kWh"
getUnit("degreeCelsius")
// => { name: "Degree Celsius", symbol: "°C", quantitativeTypeId: "Temperature" }
```

```ts
import type { UnitsOf } from "@sixb/core"

type TempUnit = UnitsOf<"Temperature">
// => "degreeCelsius" | "degreeFahrenheit" | "kelvin"
```

## Related

- [Properties](./properties.md) — declaring `semanticType` on `prop(...)`
- [Value Types](./value-types.md) — sharing a semantic type across properties
- [Telemetry](../objects/telemetry.md) — appending values with a `unit`
- [Object Types](./object-types.md) — where properties live
