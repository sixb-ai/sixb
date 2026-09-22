# Properties

A property is a named value on an object, such as an invoice's number, status, or due date.
Its schema determines which values Sixb accepts.

## Define a property

Add `prop(id, schema, options?)` to an object type's `properties` array:

```ts
import { prop, stringEnum } from "@sixb/core/ontology"

prop("number", "string", { required: true })
prop("status", stringEnum(["draft", "sent", "paid"]))
```

IDs must be unique within the type. Use `name` for a separate display label and `description`
for additional context. Without a name, Sixb uses the ID.

## Choose a schema

| Schema | Values |
| --- | --- |
| `"string"`, `"uuid"` | Text or a UUID string. |
| `"boolean"` | `true` or `false`. |
| `"integer"`, `"double"` | Whole numbers or floating-point numbers. |
| `"decimal"` | Exact decimal values, represented as strings. |
| `"date"`, `"timestamp"` | A calendar date or timestamp. Writes accept `Date` values or ISO strings. |
| `"fileRef"` | A reference to an uploaded file. |
| `stringEnum([...])`, `integerEnum([...])` | A fixed set of string or integer values. |
| `array`, `object`, `map` | Structured values, shown below. |
| `valueTypeRef(ValueType)` | A [reusable schema](value-types.md). |

For exact decimal values, use `decimal()` with a string rather than converting through a
JavaScript number:

```ts
import { decimal, prop } from "@sixb/core/ontology"

prop("amount", "decimal")
const amount = decimal("124.50")
```

Keep a separate currency property when an amount represents money. Physical [units](units-and-semantics.md)
are for measurements such as temperature or pressure.

## Required and nullable values

Properties are optional and non-nullable by default. `required` means a new object must include
the property. `nullable` allows an explicit `null` value. The two options are independent:

```ts
prop("number", "string", { required: true })
prop("note", "string", { nullable: true })
```

An omitted property and a property set to `null` are different values. Updating an existing
object can leave required properties unchanged; see [Create or update an object](../objects/overview.md#create-or-update-an-object).

The [primary property](object-types.md#give-objects-an-identity) is always a required string.

## Structured values

Use arrays for lists, objects for named fields, and maps for dynamic keys:

```ts
prop("tags", { type: "array", items: "string" })

prop("address", {
  type: "object",
  properties: {
    street: { schema: "string", required: true },
    city: { schema: "string", required: true },
    postcode: { schema: "string" },
  },
})

prop("labels", { type: "map", keySchema: "string", valueSchema: "string" })
```

Nested fields can be required or nullable, and structured schemas can be nested. There is no
unrestricted `json` property schema; describe the shape you expect.

Use a [value type](value-types.md) when several properties share a shape. If the value needs its
own identity or relationships, define an object type and connect it with a [link](links.md).

## Enable queries

Add `query` options to the properties you filter, sort, search, or group. Set `searchable: true`
alongside the capabilities you need:

```ts
prop("status", stringEnum(["draft", "sent", "paid"]), {
  query: { searchable: true, filterable: true, facet: true },
})

prop("dueDate", "date", {
  query: { searchable: true, filterable: true, sortable: true },
})
```

| Option | Enables |
| --- | --- |
| `searchable` | Required for all other query options. |
| `filterable` | Property predicates such as equality, ranges, and existence. |
| `sortable` | Ordering results by this property. |
| `text` | Keyword search on a string or string enum. |
| `exact` | Using this property in the type's exact-match search profile. |
| `facet` | Grouped counts for scalar or enum values, excluding file references. |
| `weight` | Positive text-ranking weight; also requires `text: true` and provider support. |

Without query options, a property can still be stored and read. Comparing the primary ID with
`eq` or `in` does not need query options. See [Querying](../objects/querying.md) for the calls these
settings enable.

### Configure search

Set `search.defaultText` on the object type to choose which fields a plain `search("...")`
query uses. Enable `text` on those properties in the same definition:

```ts
// ontology/customer.ts
import { defineObjectType, prop } from "@sixb/core/ontology"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, sortable: true },
    }),
  ],
  search: {
    title: "name",
    defaultText: ["name"],
    exact: ["id"],
  },
})
```

`title` selects the string field used to label search results. `exact` lists exact-match fields;
each needs `query.exact: true`, except the primary ID. Search profiles use static properties.

### Configure vector search

Use `search.vectors` to search by meaning. Each named profile combines static string or string-enum
properties with a [registered embedding model](../models/configuration.md#embedding-models):

```ts
// ontology/product.ts
import { defineObjectType, prop } from "@sixb/core/ontology"
import { productEmbedding } from "../lib/models"

export const Product = defineObjectType({
  id: "Product",
  name: "Product",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("description", "string"),
  ],
  search: {
    vectors: {
      content: { source: ["title", "description"], model: productEmbedding },
    },
  },
})
```

The source properties need no query flags. Sixb stores embeddings separately from your object's
properties. See [Search by meaning](../objects/querying.md#search-by-meaning) for indexing and querying.

## Record history

Properties use `mode: "static"` by default: they hold the object's current value. Use
`mode: "telemetry"` when you also need a timestamped history:

```ts
prop("progress", "integer", { mode: "telemetry" })
prop("online", "boolean", { mode: "telemetry" })
```

Telemetry supports scalar and structured values, but cannot contain file references. Values
with a physical `semanticType` also require a valid [unit](units-and-semantics.md).

See [Telemetry](../objects/telemetry.md) for appending readings and querying their history.
