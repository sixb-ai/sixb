# Ontology

An ontology describes the types of objects in your domain, their properties, relationships,
and actions.


## What it is

- a schema for the twin graph: what kinds of objects exist, what they hold, and how they
  connect
- built from object types, properties, links, and actions
- each object type has one primary property that uniquely identifies instances
- types can inherit from other types
- types can reference reusable value types for shared schemas
- registered at startup, validated, and used by the runtime for CRUD, telemetry, and
  projection


## Building blocks

| Piece | Role |
| --- | --- |
| ObjectType | A real-world entity, asset, or concept |
| Property | An attribute on an object type (name, schema, mode) |
| ObjectLink | A directional relationship from one object type to another |
| Action | A command that can be dispatched against an object instance |
| ValueType | A reusable named schema shared across properties |
| Interface | A reusable contract of properties, links, and actions |


## Define an object type

File: `ontology/customer.ts`

```ts
import { defineObjectType, prop, link, stringEnum } from "@sixb/core"
import { Organization } from "./organization"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  description: "A customer account in the system.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string"),
    prop("tier", stringEnum(["free", "starter", "business", "enterprise"])),
    prop("monthlySpend", "double", { mode: "telemetry", semanticType: "Currency" }),
  ],
  links: [
    link("belongsTo", Organization, { cardinality: "one" }),
    link("hasOrders", "Order"),
  ],
})
```

`defineObjectType()` returns the type definition plus typed tokens for properties and links:
`Customer.p.name`, `Customer.p.monthlySpend`, `Customer.l.belongsTo`, etc.


## Properties

A property is an attribute on an object type.

```ts
prop("name", "string", { required: true })
prop("monthlySpend", "double", { mode: "telemetry", semanticType: "Currency" })
prop("id", "string", { required: true, primary: true })
```

### Schemas

Sixb supports several schema types for property values:

| Schema | Example |
| --- | --- |
| Primitive | `"string"`, `"integer"`, `"double"`, `"boolean"`, `"date"`, `"timestamp"`, `"uuid"`, `"fileRef"` |
| Enum | `stringEnum(["draft", "confirmed", "shipped"])`, `integerEnum([1, 2, 3])` |
| Object | `{ type: "object", properties: { amount: { schema: "double", required: true } } }` |
| Array | `{ type: "array", items: "string" }` |
| Map | `{ type: "map", keySchema: "string", valueSchema: "double" }` |
| ValueType ref | `valueTypeRef(Money)` |

Use `"fileRef"` for blob-backed documents, images, and attachments:

```ts
prop("pdf", "fileRef", { nullable: true })
```

Object upserts store only the `FileRef` metadata. Upload and download bytes through
`sixb.blobStorage`; `fileRef` properties cannot use `mode: "telemetry"`.

### Property mode

Properties have a mode that determines their runtime behavior:

| Mode | Behavior |
| --- | --- |
| `"static"` (default) | Stored as part of the object record. Rarely changes. |
| `"telemetry"` | Appended to a time-series store. The object record holds only the latest value. |

### Semantic type

Numeric properties can declare a `semanticType` such as `"Currency"` or `"Weight"`. This
constrains which units are valid when appending telemetry values, for example `USD`
for a Currency property.


## Primary property

Every object type must declare exactly one property as `primary: true`. This property
uniquely identifies object instances within that type and serves as the runtime key.

```ts
prop("id", "string", { required: true, primary: true })
```

Rules enforced at startup:

- exactly one primary property per type (after inheritance)
- the primary property must be `required: true`
- the primary property must have a `"string"` schema

When you upsert an object, the primary property value is extracted automatically from the
properties you provide. There is no separate `key` parameter:

```ts
await sixb.objects(Customer).upsert({
  properties: { id: "cust-001", name: "Acme Corp" },
})
// customer.id === "cust-001" (the primary value)
```

Retrieval uses the primary value directly:

```ts
const customer = await sixb.objects(Customer).get("cust-001")
```


## Links

A link is a directional relationship from one object type to another.

```ts
// Single target type (ObjectType reference)
link("belongsTo", Organization, { cardinality: "one" })

// Multiple target types
link("payments", [CreditCard, BankAccount])

// String target (for circular references or external types)
link("hasOrders", "Order")

// Wildcard (any target type)
link("assignedTo")
```

| Option | Values | Default |
| --- | --- | --- |
| `cardinality` | `"one"`, `"many"` | `"many"` |
| `properties` | `Property[]` | none |

Links can carry metadata via `properties`:

```ts
link("placedBy", Customer, {
  cardinality: "one",
  properties: [
    prop("placedAt", "timestamp", { required: true }),
    prop("channel", "string"),
  ],
})
```

Passing an ObjectType object directly (instead of a string id) gives compile-time type safety.
String targets are still supported for cases like circular module dependencies.

Wildcard links (`link("rel")`) accept any target object type at runtime. Polymorphic links
(array of targets) accept any of the listed types plus their subtypes.


## Actions

An action models a command that can be dispatched against an object instance, such as issuing
a credit or cancelling an order.

```ts
import { actionParam, defineAction } from "@sixb/core"
import { Customer } from "../ontology/customer"

export const issueCredit = defineAction("issueCredit")
  .target(Customer)
  .params({
    amount: actionParam("double", { required: true, semanticType: "Currency" }),
  })
  .run(async ({ params, target, sixb }) => {
    const billing = await sixb.connector(billingConnector)
    await billing.issueCredit(target.primaryId, params.amount)
  })
```

Actions define the contract, validation, and handler together. `requestAction(...)`
validates the action id, parameter shape, and target object, then emits `action.requested`.
The V1 definition layer captures handlers but does not execute them.


## Value types

A value type is a reusable named schema shared across properties. Use it when multiple
properties need the same structure.

```ts
import { defineValueType } from "@sixb/core"

export const Money = defineValueType({
  id: "money",
  name: "Money",
  schema: "double",
  semanticType: "Currency",
})
```

Reference it from properties:

```ts
prop("monthlySpend", valueTypeRef(Money), { mode: "telemetry" })
```


## Inheritance

Object types can extend a parent type. The child inherits all properties, links, and actions
from the parent.

```ts
const Product = defineObjectType({
  id: "Product",
  name: "Product",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
  ],
})

const DigitalProduct = defineObjectType({
  extends: Product,
  id: "DigitalProduct",
  name: "Digital Product",
  properties: [prop("fileSize", "double")],
})

const Subscription = defineObjectType({
  extends: DigitalProduct,
  id: "Subscription",
  name: "Subscription",
  properties: [prop("billingCycle", "string")],
})

// Subscription has: id (from Product), name (from Product), fileSize (from DigitalProduct), billingCycle
// Subscription.p.name, Subscription.p.fileSize, Subscription.p.billingCycle all work
```

Rules:

- only root types (no `extends`) define the primary property; children inherit it
- a child can override a parent property by declaring one with the same id
- circular extends chains are detected and rejected at startup
- link targets accept subtypes: a link targeting `Product` accepts `Subscription` at runtime

### Multi-parent classification

For ontologies where a type belongs to multiple parent categories (e.g., Brick `rdfs:subClassOf`
with multiple parents), use `parents`:

```ts
const GiftCard = defineObjectType({
  extends: DigitalProduct,
  id: "GiftCard",
  name: "Gift Card",
  parents: ["PaymentMethod"],
  properties: [],
})
// GiftCard.parents === ["DigitalProduct", "PaymentMethod"]
```

`extends` determines structural inheritance (property merge). `parents` records additional
classification for subtype queries.


## Type tokens

`defineObjectType()` returns an object with typed token maps:

- `Customer.p` — property tokens keyed by property id
- `Customer.l` — link tokens keyed by link id

Tokens carry type information about the object type, property, or link they refer to. They are
used throughout the Sixb API for type-safe operations:

```ts
// Telemetry with compile-time unit checking
await sixb.objects(Customer).byId("cust-001").telemetry(Customer.p.monthlySpend).append({
  value: 1250.00,
  unit: "USD",
})

// Linking with type-safe tokens
await sixb.objects(Customer).byId("cust-001").link(Customer.l.belongsTo, {
  objectTypeId: "Organization",
  primaryId: "org-1",
})

// Used in projections
fromForeignKey({
  link: Customer.l.belongsTo,
  sourceProperty: Customer.p.organizationRef,
  target: Organization,
})
```


## Convention

Export object type definitions from `ontology/`:

```txt
your-project/
  ontology/
    organization.ts
    customer.ts
    order.ts
  sixb.config.ts
```

`createSixb()` scans `ontology/` and registers exported object types and value types
automatically.

You can also register types explicitly with `createSixb({ ontology: [Customer, Organization] })`.


## Typed API

Once registered, access objects through the typed API:

```ts
const customers = sixb.objects(Customer)

// Create or update
const customer = await customers.upsert({
  properties: { id: "cust-001", name: "Acme Corp", tier: "business" },
})

// Read
const found = await customers.get("cust-001")

// List with filters
const results = await customers.list({
  where: (c) => c.p.tier.eq("enterprise"),
  limit: 10,
})

// Telemetry
await customers.byId("cust-001").telemetry(Customer.p.monthlySpend).append({
  value: 1250.00,
  unit: "USD",
  at: new Date(),
})

// Batch telemetry
await customers.appendTelemetryBatch([
  { id: "cust-001", properties: { monthlySpend: { value: 1250.00, unit: "USD" } } },
  { id: "cust-002", properties: { monthlySpend: { value: 890.50, unit: "USD" } } },
])

// Links
await customers.byId("cust-001").link(Customer.l.belongsTo, {
  objectTypeId: "Organization",
  primaryId: "org-1",
})

// Actions
await customers.byId("cust-001").requestAction({
  actionId: "issueCredit",
  params: { amount: { value: 500.00, unit: "USD" } },
})
```


## Events

All write operations emit typed events through the events runtime:

| Event | Trigger |
| --- | --- |
| `object.upserted` | Object created or updated |
| `telemetry.appended` | Telemetry value appended |
| `link.upserted` | Link created or updated |
| `link.removed` | Link removed |
| `action.requested` | Action dispatched |


## Lifecycle

1. Define object types with `defineObjectType()`, using `prop()` and `link()`.
2. Optionally define value types with `defineValueType()`.
3. Define actions with `defineAction()` in `actions/` or pass them to `createSixb()`.
4. Export definitions from `ontology/` or pass them to `createSixb()`.
5. Sixb validates types at startup: primaries, extends chains, link targets, action targets.
6. Use `sixb.objects(Type)` for typed CRUD, telemetry, links, and action requests.


## Guidelines

- Define one primary property per type using `prop("id", "string", { required: true, primary: true })`.
- Use `link()` with ObjectType references instead of string ids when possible.
- Use `mode: "telemetry"` for time-varying measurements, `"static"` for facts.
- Keep type definitions declarative. Avoid indirection around ontology setup.
- Use `semanticType` on numeric properties to constrain valid units.
- Place common properties in a parent type and use `extends` for sharing.
