# Units

Units describe physical measurements such as temperature, pressure, or energy. Set a property's
`semanticType` to the quantity it measures so Sixb can validate the unit supplied with each
telemetry reading.

## Define a measurement

This sensor records temperature over time:

```ts
// ontology/sensor.ts
import { defineObjectType, prop } from "@sixb/core/ontology"

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

Use a numeric schema such as `"double"`, `"integer"`, or `"decimal"`. For measurements reused
across types, you can also put `semanticType` on an exported [value type](value-types.md).

## Supply a unit

When appending a reading to an existing sensor, include its unit ID:

```ts
import { Sensor } from "./ontology/sensor"

await sixb.objects(Sensor).byId("sensor-1").telemetry(Sensor.p.temperature).append({
  value: 21.5,
  unit: "degreeCelsius",
  at: new Date(),
})
```

A property with a semantic type requires a unit from that quantity. Temperature accepts
`degreeCelsius`, `degreeFahrenheit`, or `kelvin`; a pressure unit is rejected. Properties without
a semantic type do not accept units.

Sixb validates and preserves the supplied value and unit. It does not convert readings to a
common unit. Normalize units in your ingestion code or a [pipeline](../pipelines/overview.md)
when you need consistent values for comparison or aggregation.

See [Telemetry](../objects/telemetry.md) for reading history and importing values in batches.

## Find available units

Use `getUnitsFor()` to list a quantity's unit IDs and display symbols. Use `getUnitSymbol()` when
rendering a known unit:

```ts
import { getUnitsFor, getUnitSymbol } from "@sixb/core/ontology"

const temperatureUnits = getUnitsFor("Temperature")
const symbol = getUnitSymbol("degreeCelsius") // "°C"
```

Other quantities include `Pressure`, `Power`, `Energy`, and `Length`. Browse the complete catalog
through the exported `quantitativeTypes` object; `QuantitativeTypeId` provides its IDs as a
TypeScript union.
