# Ontology

An ontology is your app's object model.

It defines the real things your software cares about, such as customers, orders, invoices,
devices, buildings, rooms, projects, or tasks. Each object type declares the properties it has
and the relationships it can make to other object types.

## Why it is useful

An ontology gives your project a shared language.

Instead of passing around loose JSON, you define the important objects once and use those
definitions everywhere:

- app screens know what properties exist
- workflows can request actions against real objects
- projections can turn rows into objects
- TypeScript can catch property and relationship mistakes
- Sixb can validate writes before they become app state

Use an ontology for the objects people interact with. Use [datasets](./datasets.md) for raw
rows and table-shaped data.

## Core terms

| Concept | Meaning |
| --- | --- |
| Object type | A kind of thing, like `Customer` or `Order` |
| Object | One instance of that type, like customer `cust-001` |
| Property | A value on the object, like `name`, `email`, or `status` |
| Link | A relationship to another object, like a customer belonging to an organization |
| Telemetry | A property value that changes over time, like temperature or monthly spend |

Most ontologies start as nouns and relationships from your domain.

## Define an object type

File: `ontology/customer.ts`

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
    prop("monthlySpend", "double", {
      mode: "telemetry",
      semanticType: "Currency",
    }),
  ],
})
```

This creates one object type: `Customer`.

The `id` property is the primary property. It uniquely identifies each customer.

## Properties

Properties describe what an object knows.

```ts
prop("name", "string", { required: true })
prop("tier", stringEnum(["free", "team", "enterprise"]))
prop("monthlySpend", "double", { mode: "telemetry", semanticType: "Currency" })
```

`prop(...)` takes these parameters:

| Parameter | Required | Expected |
| --- | --- | --- |
| `id` | Yes | A stable property key, unique within the object type |
| `schema` | Yes | A `Schema` value that describes which values the property accepts |
| `options` | No | An object for metadata and behavior |

`options` accepts these fields:

| Option | Expected | Meaning |
| --- | --- | --- |
| `name` | `string` | Display name. Defaults to the property `id`. |
| `description` | `string` | Human-readable context for the property. |
| `required` | `boolean` | The property must be present when writing an object. |
| `nullable` | `boolean` | The property may be set to `null`. |
| `primary` | `true` | Marks the property as the object identifier. |
| `mode` | `"static"` or `"telemetry"` | Controls how the value is stored over time. |
| `semanticType` | Quantitative type id | Declares the unit family for numeric values. |

When omitted, `mode` is `"static"`: the value is stored as a fact on the object record.
Use `mode: "telemetry"` for time-varying measurements, readings, or counters. Telemetry
values are appended over time, and the object record keeps the latest value.

Each object type must have exactly one primary property. The primary property must use
`{ required: true, primary: true }` with a `"string"` schema. `semanticType` is only useful
with numeric schemas like `"double"`, `"integer"`, or `"decimal"`.

The schema is usually one of these forms:

| Form | Examples | Use it for |
| --- | --- | --- |
| Primitive | `"string"`, `"boolean"`, `"integer"`, `"double"`, `"decimal"` | Scalar values |
| Date/time | `"date"`, `"timestamp"` | Dates or timestamps, as `Date` values or ISO strings |
| Identifier | `"uuid"` | String identifiers that should be treated as UUIDs |
| File reference | `"fileRef"` | Blob-backed documents, images, and attachments |
| Enum | `stringEnum([...])`, `integerEnum([...])` | A fixed set of string or integer values |
| Value type ref | `valueTypeRef("temperatureReading")` | Reusing a named value shape |

The primitive schemas are `string`, `integer`, `double`, `decimal`, `boolean`, `date`,
`timestamp`, `uuid`, and `fileRef`.

Keep ontology properties shallow. Avoid complex nested shapes such as object fields that contain
arrays, arrays of objects, or deeply nested records. When a value starts to behave like another
thing in your domain, model it as a separate object type and connect it with a link.

Telemetry properties cannot use `fileRef`.

There are two common property styles:

| Style | Use it for |
| --- | --- |
| Static property | Facts that are stored on the object, like `name` or `email` |
| Telemetry property | Values that change over time, like `temperature` or `monthlySpend` |

Start with static properties. Add telemetry only when you care about the history of a value.

## Links

Links describe how objects relate to each other.

File: `ontology/organization.ts`

```ts
import { defineObjectType, prop } from "@sixb/core"

export const Organization = defineObjectType({
  id: "Organization",
  name: "Organization",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})
```

Then link customers to organizations:

```ts
import { defineObjectType, link, prop } from "@sixb/core"
import { Organization } from "./organization"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link("belongsTo", Organization, { cardinality: "one" })],
})
```

`link(...)` takes these parameters:

| Parameter | Required | Expected |
| --- | --- | --- |
| `id` | Yes | A stable relationship key, unique within the source object type |
| `target` | No | The object type this link can point to |
| `options` | No | An object for metadata and relationship behavior |

The `target` can be an object type, an object type id, or an array of allowed object types or ids:

```ts
link("belongsTo", Organization)
link("belongsTo", "Organization")
link("relatedTo", [Organization, Customer])
```

When the target is omitted or set to `"*"`, the link is a wildcard link and can point to any
object type. Prefer a specific target for relationships your app understands.

`options` accepts these fields:

| Option | Expected | Meaning |
| --- | --- | --- |
| `name` | `string` | Display name. Defaults to the link `id`. |
| `description` | `string` | Human-readable context for the relationship. |
| `cardinality` | `"one"` or `"many"` | Whether each source links to one or many targets. |
| `properties` | `Property[]` | Metadata stored on each relationship instance. |

Use `cardinality: "one"` when each source object should have at most one target for this link,
like one customer belonging to one organization. Use `cardinality: "many"` when the source can
point to multiple targets.

Link `properties` use `prop(...)` too, but they describe the relationship itself, not either
object. Good examples are `installedAt`, `commissionedBy`, or `confidence`. If a link does not
declare properties, writes with link properties are rejected.

Use links for relationships your app needs to navigate or query.

## Use objects from code

Once an object type is registered, use `sixb.objects(Type)`.

```ts
import { Customer } from "./ontology/customer"

const customers = sixb.objects(Customer)

await customers.upsert({
  properties: {
    id: "cust-001",
    name: "Acme Corp",
    email: "team@acme.example",
    tier: "enterprise",
  },
})

const customer = await customers.get("cust-001")
```

TypeScript understands the properties from your ontology. If you mistype `tier` or pass a value
outside the enum, you get feedback while writing code.

## Use telemetry

Telemetry stores a value over time.

```ts
await sixb.objects(Customer).byId("cust-001").telemetry(Customer.p.monthlySpend).append({
  value: 1250,
  unit: "USD",
  at: new Date(),
})
```

Use telemetry for changing measurements, readings, counters, or values where history matters.

## Use links

Create relationships with typed link tokens.

```ts
await sixb.objects(Customer).byId("cust-001").link(Customer.l.belongsTo, {
  objectTypeId: "Organization",
  primaryId: "org-001",
})
```

The link token comes from the object type: `Customer.l.belongsTo`.

## Convention

Put object types in `ontology/` and export them.

```txt
your-project/
  ontology/
    customer.ts
    organization.ts
    order.ts
  sixb.config.ts
```

`createSixb()` discovers exported object types from `ontology/` automatically.

You can also register object types explicitly:

```ts
import { createSixb } from "@sixb/core"
import { Customer } from "./ontology/customer"
import { Organization } from "./ontology/organization"

export const sixb = createSixb({
  ontology: [Customer, Organization],
})
```

## How to model your domain

Start small.

1. Pick one object your app cares about.
2. Give it an `id` primary property.
3. Add the properties users need to see or workflows need to use.
4. Add links only for relationships that matter in the app.
5. Add telemetry only for values where history matters.

Good object types are business-readable. `Customer`, `Invoice`, `Device`, `Room`, and `Task`
are usually better starting points than implementation names.

## Extra details

- `stringEnum(...)` and `integerEnum(...)` constrain allowed values.
- `semanticType` adds unit-aware numeric values like currency or temperature.
- `valueTypeRef(...)` reuses the same value shape across properties.
- `extends` lets one object type inherit properties and links from another.
- `fileRef` stores references to documents, images, and other blobs.
- actions live in `actions/` and target ontology objects when users can request commands.

The important first step is to define the objects your app is about. Everything else can grow
from there.
