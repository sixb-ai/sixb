# Properties

Properties describe what an object knows. Each one is a named value on an
[object type](./object-types.md), declared with `prop(...)`.

```ts
import { defineObjectType, prop, stringEnum } from "@sixb/core"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string"),
    prop("tier", stringEnum(["free", "team", "enterprise"])),
  ],
})
```

## prop() parameters

`prop(id, schema, options?)` takes these parameters:

| Parameter | Required | Expected |
| --- | --- | --- |
| `id` | Yes | A stable property key, unique within the object type. |
| `schema` | Yes | A `Schema` value that describes which values the property accepts. |
| `options` | No | An object for metadata and behavior. |

`name` defaults to `id`. Override it with `options.name` when you need a separate
display name.

## Options

`options` accepts these fields:

| Option | Expected | Meaning |
| --- | --- | --- |
| `name` | `string` | Display name. Defaults to the property `id`. |
| `description` | `string` | Human-readable context for the property. |
| `required` | `boolean` | The property must be present when writing an object. |
| `nullable` | `boolean` | The property may be set to `null`. |
| `primary` | `true` | Marks the property as the object identifier. |
| `mode` | `"static"` or `"telemetry"` | Controls how the value is stored over time. |
| `semanticType` | Quantitative type id | Declares the unit family for numeric values. See [units and semantics](./units-and-semantics.md). |
| `query` | `PropertyQueryMetadata` | Indexing and query flags. See [search metadata](./search-metadata.md). |

Each object type must have exactly one primary property. The primary property
must use `{ required: true, primary: true }` with a `"string"` schema. Only `true`
is accepted for `primary` — there is no "explicitly not primary" value.

`semanticType` is only meaningful with numeric schemas like `"double"`,
`"integer"`, or `"decimal"`.

## Schema forms

The `schema` argument is usually one of these forms:

| Form | Examples | Use it for |
| --- | --- | --- |
| Primitive | `"string"`, `"boolean"`, `"integer"`, `"double"`, `"decimal"` | Scalar values |
| Date/time | `"date"`, `"timestamp"` | Dates or timestamps, as `Date` values or ISO strings |
| Identifier | `"uuid"` | String identifiers treated as UUIDs |
| File reference | `"fileRef"` | Blob-backed documents, images, and attachments |
| Enum | `stringEnum([...])`, `integerEnum([...])` | A fixed set of string or integer values |
| Value type ref | `valueTypeRef("temperatureReading")` | Reusing a named value shape |

The primitive schemas are `string`, `integer`, `double`, `decimal`, `boolean`,
`date`, `timestamp`, `uuid`, and `fileRef`.

Enum helpers produce a constrained set of allowed values:

```ts
prop("tier", stringEnum(["free", "team", "enterprise"]))
prop("fanSpeed", integerEnum([1, 2, 3]))
```

A value type ref points at a reusable named shape. Use it when several properties
share the same semantics. See [value types](./value-types.md).

```ts
import { prop, valueTypeRef } from "@sixb/core"

prop("inletTemp", valueTypeRef("temperatureReading"))
```

## Static vs telemetry mode

`mode` controls how a value is stored over time.

| Mode | Use it for |
| --- | --- |
| `"static"` (default) | Facts stored on the object record, like `name` or `email`. |
| `"telemetry"` | Values that change over time, like a temperature reading or a counter. |

When omitted, `mode` is `"static"`: the value is stored as a fact on the object
record. Use `mode: "telemetry"` for time-varying measurements, readings, or
counters. Telemetry values are appended over time, and the object record keeps the
latest value.

```ts
prop("currentTemperature", "double", {
  mode: "telemetry",
  semanticType: "Temperature",
})
```

Start with static properties. Add telemetry only when you care about the history
of a value. Telemetry properties cannot use the `"fileRef"` schema.

Appending and reading telemetry values is covered in
[objects / telemetry](../objects/telemetry.md).

## Keep properties shallow

Keep ontology properties shallow. Avoid complex nested shapes such as object
fields that contain arrays, arrays of objects, or deeply nested records.

When a value starts to behave like another thing in your domain, model it as a
separate object type and connect it with a [link](./links.md) instead. For numeric
measurements that carry a unit, reach for `semanticType` rather than a nested
`{ value, unit }` object — see [units and semantics](./units-and-semantics.md).
