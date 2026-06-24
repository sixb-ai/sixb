# Links

Links describe how objects relate: a project is delivered for a customer, led by one employee, and
staffed by many. Declare links on the source [object type](./object-types.md) with `link(...)`,
then write and traverse them through the typed API.

Use links for relationships your app needs to navigate, query, or display. For values that live on
a single object, use [properties](./properties.md) instead.

## Declare a link

Add a `links` array to `defineObjectType`. Each entry connects this object type (the source) to a
target object type.

```ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Customer } from "./customer"
import { Employee } from "./employee"

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("status", stringEnum(["draft", "active", "paused", "completed", "cancelled"])),
  ],
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("lead", Employee, { cardinality: "one" }),
    link("members", Employee, { cardinality: "many" }),
  ],
})
```

## link() parameters

```ts
link(id, target?, options?)
```

| Parameter | Required | Expected |
| --- | --- | --- |
| `id` | Yes | A stable relationship key, unique within the source object type |
| `target` | No | The object type(s) this link can point to. Defaults to `"*"` (wildcard) |
| `options` | No | Metadata and relationship behavior |

`options` accepts:

| Option | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Display name. Defaults to the link `id`. |
| `description` | `string` | Human-readable context for the relationship. |
| `cardinality` | `"one"` \| `"many"` | Whether each source links to one or many targets. |
| `properties` | `Property[]` | Metadata stored on each relationship instance. |

## Target forms

`target` accepts an object type, an object type id string, an array of either, or nothing
(wildcard).

| Form | Example | Points to |
| --- | --- | --- |
| Object type | `link("customer", Customer)` | One specific type |
| Object type id | `link("customer", "Customer")` | One specific type, by id |
| Array of types | `link("relatedTo", [Project, Task])` | Any of the listed types |
| Array of ids | `link("relatedTo", ["Project", "Task"])` | Any of the listed types |
| Wildcard (omitted) | `link("anything")` | Any object type |
| Wildcard with options | `link("anything", { cardinality: "many" })` | Any object type |

Passing an object type extracts its `.id` at build time, so `link("customer", Customer)` and
`link("customer", "Customer")` produce the same result. Prefer the object-type form — it keeps the
target type-checked and powers typed traversal.

When the target is omitted or `"*"`, the link is a **wildcard** and can point to any object type.
Prefer a specific target; reserve wildcards for genuinely polymorphic relationships.

## Cardinality

`cardinality` controls how many targets each source object can link to under this link id.

| Value | Meaning |
| --- | --- |
| `"one"` | Each source links to at most one target — a project has one `lead`. |
| `"many"` | The source can link to multiple targets — a project has many `members`. |

```ts
link("lead", Employee, { cardinality: "one" })
link("members", Employee, { cardinality: "many" })
```

## Link properties

A link can carry metadata about the relationship itself — not about either object. Declare these
with `prop(...)`, exactly like object [properties](./properties.md).

```ts
import { defineObjectType, link, prop } from "@sixb/core/ontology"
import { Employee } from "./employee"

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [
    link("members", Employee, {
      cardinality: "many",
      properties: [
        prop("role", "string"),
        prop("allocatedAt", "timestamp"),
      ],
    }),
  ],
})
```

Good link properties are facts about the connection: a member's `role` on the project, when they
were `allocatedAt`, or a `confidence` score. If a link does not declare `properties`, writing a
link with properties is rejected with an `OntologyValidationError`.

## Create and remove links

Once a type is registered, write links through the typed API on a `byId(...)` handle. The link
token comes from the object type as `Type.l.<linkId>`.

```ts
const projects = sixb.objects(Project)

// Link to a target by object reference
await projects.byId("proj-001").link(Project.l.members, {
  objectTypeId: "Employee",
  primaryId: "emp-014",
})

// With link properties
await projects.byId("proj-001").link(
  Project.l.members,
  { objectTypeId: "Employee", primaryId: "emp-014" },
  { properties: { role: "backend", allocatedAt: new Date() } }
)

// Remove a link
await projects.byId("proj-001").unlink(Project.l.members, {
  objectTypeId: "Employee",
  primaryId: "emp-014",
})
```

The target is an `ObjectRef` (`{ objectTypeId, primaryId }`). TypeScript checks it against the
link's declared target, so linking `members` to a `Customer` is a compile error.

Writing a link emits a `link.upserted` [event](../events/overview.md); removing one emits
`link.removed`.

## List links from an object

`listLinks(...)` returns the relationship rows for an object, optionally filtered to one link token.

```ts
// All links from this project
const all = await sixb.objects(Project).byId("proj-001").listLinks()

// Only members links
const members = await sixb
  .objects(Project)
  .byId("proj-001")
  .listLinks(Project.l.members)
```

## Traverse links in queries

`traverse(...)` follows a link inside an [object query](../objects/querying.md) and changes the
result type to the type on the other end of the link.

```ts
// Outgoing: from a project to its members
const members = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.id.eq("proj-001"))
  .traverse(Project.l.members)
  .list()
```

Pass `{ direction: "incoming" }` to walk a link backwards — from the link's target type to its
source type:

```ts
// Incoming: from a customer to the active projects that link to it
const projects = await sixb
  .objects(Customer)
  .query()
  .where((customer) => customer.p.id.eq("cust-001"))
  .traverse(Project.l.customer, { direction: "incoming" })
  .where((project) => project.p.status.eq("active"))
  .list()
```

| Direction | Token comes from | Result type |
| --- | --- | --- |
| `"outgoing"` (default) | The source type's link | The link's target type |
| `"incoming"` | The other type's link | The link's source type |

After `traverse(...)`, the builder operates on the new result type, so `where(...)`,
`orderBy(...)`, and `list(...)` apply to the traversed objects.

## Inherited links

When an object type uses `extends`, it inherits the parent's links along with its properties. A
`Contract extends Document` gains `Document`'s `project` and `author` links without redeclaring
them. See [object types](./object-types.md) for inheritance details.

## Related

- [Object types](./object-types.md) — declare the types links connect
- [Properties](./properties.md) — values that live on a single object
- [Querying objects](../objects/querying.md) — filters, ordering, and `traverse`
- [CRUD](../objects/crud.md) — upsert, link, and unlink from code
- [Events](../events/overview.md) — `link.upserted` and `link.removed`
