# Properties

Properties describe what an object knows. Each one is a named value on an
[object type](./object-types.md), declared with `prop(...)`.

```ts
import { defineObjectType, prop, stringEnum } from "@sixb/core/ontology"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string"),
    prop("tier", stringEnum(["bronze", "silver", "gold", "platinum"])),
  ],
})
```

## prop() signature

`prop(id, schema, options?)`:

| Argument | Required | What it is |
| --- | --- | --- |
| `id` | Yes | A stable property key, unique within the object type. |
| `schema` | Yes | A `Schema` describing which values the property accepts. |
| `options` | No | Metadata and behavior (see below). `name` defaults to `id`. |

## Options

| Option | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Display name. Defaults to the property `id`. |
| `description` | `string` | Human-readable context for the property. |
| `required` | `boolean` | The property must be present when writing an object. |
| `nullable` | `boolean` | The property may be set to `null`. |
| `primary` | `true` | Marks the property as the object identifier. |
| `mode` | `"static"` \| `"telemetry"` | How the value is stored over time. Defaults to `"static"`. |
| `semanticType` | Quantitative type id | Unit family for physical numeric readings. See [units and semantics](./units-and-semantics.md). |
| `query` | `PropertyQueryMetadata` | Search, filter, and sort flags. See [search metadata](./search-metadata.md). |

Each object type must have exactly one primary property, declared with
`{ required: true, primary: true }` and a `"string"` schema. Only `true` is
accepted for `primary` — there is no "explicitly not primary" value.

A property is only queryable if it declares `query` metadata. Without it, you
can't filter, sort, or search on that property.

```ts
prop("status", stringEnum(["draft", "sent", "paid", "overdue", "cancelled"]), {
  query: { searchable: true, filterable: true, exact: true, facet: true },
})
prop("amount", "double", {
  query: { searchable: true, filterable: true, sortable: true },
})
```

## Schema forms

The `schema` argument is one of these forms:

| Form | Examples | Use it for |
| --- | --- | --- |
| Primitive | `"string"`, `"boolean"`, `"integer"`, `"double"`, `"decimal"` | Scalar values |
| Date/time | `"date"`, `"timestamp"` | Dates or timestamps, as `Date` values or ISO strings |
| Identifier | `"uuid"` | String identifiers treated as UUIDs |
| File reference | `"fileRef"` | Blob-backed documents, images, and attachments |
| Enum | `stringEnum([...])`, `integerEnum([...])` | A fixed set of string or integer values |
| Value type ref | `valueTypeRef("...")` | Reusing a named value shape |

Enum helpers constrain a property to a fixed set of values:

```ts
prop("tier", stringEnum(["bronze", "silver", "gold", "platinum"]))
prop("status", stringEnum(["draft", "active", "paused", "completed", "cancelled"]))
```

`integerEnum([...])` is the integer counterpart for a fixed set of numeric codes,
such as `integerEnum([1, 2, 3])` for a rating scale.

A value type ref points at a reusable named shape — reach for it when several
properties share the same semantics. See [value types](./value-types.md).

```ts
import { prop, valueTypeRef } from "@sixb/core/ontology"

prop("budget", valueTypeRef("MoneyAmount"))
```

### Modeling money

Money is two properties: an `amount` and a `currency`. There is no money
quantitative type — do not use `semanticType` for it.

```ts
prop("amount", "double", { required: true }),
prop("currency", stringEnum(["EUR", "USD", "GBP"])),
```

`semanticType` is for physical readings (temperature, pressure) and only applies
to numeric schemas. See [units and semantics](./units-and-semantics.md).

## Static vs telemetry mode

`mode` controls how a value is stored over time.

| Mode | Use it for |
| --- | --- |
| `"static"` (default) | Facts stored on the object record, like `name`, `status`, or `budget`. |
| `"telemetry"` | Values that change over time, like a progress counter or a headcount. |

A static value is stored as a fact on the object record and overwritten on each
write. A telemetry value is appended to a time series; the object record keeps
only the latest value, and the history is queryable.

```ts
prop("progress", "integer", { mode: "telemetry" })
```

Start with static properties. Add telemetry only when you care about the history
of a value. Telemetry properties cannot use the `"fileRef"` schema, and a
telemetry property with no `semanticType` cannot carry a unit.

Appending and reading telemetry values is covered in
[objects / telemetry](../objects/telemetry.md).

## Keep properties shallow

Avoid complex nested shapes — object fields holding arrays, arrays of objects, or
deeply nested records. When a value starts to behave like another thing in your
domain, model it as a separate [object type](./object-types.md) and connect it
with a [link](./links.md) instead.

## Related

- [Object types](./object-types.md) — the container properties live on
- [Links](./links.md) — model relationships instead of nested values
- [Value types](./value-types.md) — reusable named value shapes
- [Search metadata](./search-metadata.md) — make a property queryable
- [Objects / telemetry](../objects/telemetry.md) — append and read telemetry
