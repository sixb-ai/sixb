# Value Types & Interfaces

Three reuse mechanisms keep an ontology DRY: **value types** (share a property
shape), **interfaces** (share a contract of properties and links), and
**extends** (inherit from a parent object type). All three are part of the
ontology layer — see [Object Types](object-types.md) and
[Properties](properties.md) for the building blocks they compose.

## Value Types

A value type is a named, reusable property shape. Define it once with
`defineValueType`, then reference it from many properties with `valueTypeRef`.
This keeps the schema and semantics consistent and easy to evolve in one place.

```ts
import { defineValueType } from "@sixb/core/ontology"

export const TemperatureReading = defineValueType({
  id: "TemperatureReading",
  name: "Temperature Reading",
  description: "A temperature measurement in a known unit.",
  schema: "double",
  semanticType: "Temperature",
})
```

### ValueType fields

| Field          | Type                | Required | Description                                              |
| -------------- | ------------------- | -------- | -------------------------------------------------------- |
| `id`           | `string`            | yes      | Unique value-type id, referenced by `valueTypeRef`.      |
| `name`         | `string`            | yes      | Display name.                                            |
| `schema`       | `Schema`            | yes      | The shared shape — a primitive, enum, object, or array.  |
| `description`  | `string`            | no       | Human-readable notes.                                    |
| `semanticType` | `QuantitativeTypeId`| no       | Physical quantity; constrains valid units. See [Units & Semantics](units-and-semantics.md). |

When `semanticType` is set, every property that references the value type
inherits the constraint — only units belonging to that quantity are valid.

### Referencing with `valueTypeRef`

`valueTypeRef` produces a schema you pass to `prop`. It has three forms:

```ts
import { defineObjectType, prop, valueTypeRef } from "@sixb/core/ontology"
import { TemperatureReading } from "./value-types"

export const Thermostat = defineObjectType({
  id: "Thermostat",
  name: "Thermostat",
  properties: [
    // 1. Pass the ValueType object — self-contained, schema is resolved inline
    prop("currentTemperature", valueTypeRef(TemperatureReading)),
    // 2. Reference by id string — resolved from the ontology registry
    prop("setpoint", valueTypeRef("TemperatureReading")),
  ],
})
```

| Form                            | When to use                                                              |
| ------------------------------- | ----------------------------------------------------------------------- |
| `valueTypeRef(ValueType)`       | You have the object in scope. Schema is resolved inline — no registry lookup needed. |
| `valueTypeRef("id")`            | Reference by id; resolved against the value types registered in the ontology. |
| `valueTypeRef("id", schema)`    | Escape hatch: supply the resolved schema explicitly alongside the id.   |

Value types referenced by id string must be registered so they can resolve —
pass them in `defineOntology({ valueTypes: [...] })`, or rely on
[convention-based discovery](overview.md). The object form
(`valueTypeRef(TemperatureReading)`) carries its own schema and resolves without
registration.

## Interfaces

An interface is a reusable contract of properties and links. Define shared
semantics once, then mark object types as implementing it. Use interfaces for
cross-cutting roles a type plays (e.g. "is a sensor", "is commissionable") that
don't fit a single inheritance chain.

```ts
import { defineInterface, prop, link } from "@sixb/core/ontology"

export const Sensor = defineInterface({
  id: "sensor",
  name: "Sensor",
  description: "Anything that produces measurements.",
  properties: [prop("manufacturer", "string"), prop("model", "string")],
  links: [link("locatedIn", "Space", { cardinality: "one" })],
})
```

`properties` and `links` both default to `[]`.

### Implementing an interface

Object types declare interface implementation by id via `implements`:

```ts
import { defineObjectType, prop } from "@sixb/core/ontology"

export const CO2Sensor = defineObjectType({
  id: "CO2Sensor",
  name: "CO2 Sensor",
  implements: ["sensor"],
  properties: [prop("ppm", "double", { semanticType: "Concentration" })],
})
```

`implements` is a list of interface ids, so one type can implement several
contracts: `implements: ["sensor", "commissionable"]`.

## Inheritance with `extends`

`extends` makes an object type inherit the properties and links of a parent.
You can pass the parent **object** (recommended — properties and links are
merged at build time) or its **id string**.

```ts
import { defineObjectType, prop, link, stringEnum } from "@sixb/core/ontology"

export const Document = defineObjectType({
  id: "Document",
  name: "Document",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("type", stringEnum(["proposal", "contract", "report"])),
  ],
  links: [link("author", "Employee", { cardinality: "one" })],
})

// Inherits all Document properties and links, adds its own.
export const Contract = defineObjectType({
  id: "Contract",
  name: "Contract",
  extends: Document,
  properties: [prop("signedAt", "timestamp"), prop("value", "double")],
})
```

`Contract.properties` here contains the merged set: `id`, `title`, `type`,
`signedAt`, and `value`. Own definitions override inherited ones with the same
id (merge is by id).

### `extends` vs `parents`

| Field      | Type                       | Purpose                                                                 |
| ---------- | -------------------------- | ---------------------------------------------------------------------- |
| `extends`  | `string \| ObjectType`     | The primary structural parent. Its properties and links are merged in. |
| `parents`  | `string[]`                 | Additional parent ids for multi-parent classification (no property merge). |

When you pass an object to `extends`, its id is also recorded in `parents`.
Use `parents` when a type belongs to several classifications but inherits its
structure from one — e.g. a `Boiler` that `extends` `HVAC_Equipment` and also
lists `Water_Heater` in `parents`.

## Choosing between them

| Mechanism      | Reuses                  | Use when                                                        |
| -------------- | ----------------------- | -------------------------------------------------------------- |
| **Value type** | A single property shape | Many properties share one schema + semantic (e.g. a reading).  |
| **Interface**  | A set of props + links  | A cross-cutting role/contract spans unrelated types.           |
| **Extends**    | A full parent type      | A subtype is-a parent type and should inherit its structure.   |

## Related

- [Object Types](object-types.md) — the primary modeling unit.
- [Properties](properties.md) — `prop`, schemas, and modes.
- [Links](links.md) — relationships between object types.
- [Units & Semantics](units-and-semantics.md) — `semanticType` and quantities.
- [Ontology overview](overview.md) — registration and discovery.
