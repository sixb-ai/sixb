# Links

Links describe how objects relate to each other: a customer belongs to an organization, a task
belongs to a project, an invoice is billed to a customer.

Links are declared on the source [object type](./object-types.md) with `link(...)`. Use links for
relationships your app needs to navigate, query, or display. For values that live on a single
object, use [properties](./properties.md) instead.

## Declare a link

Add a `links` array to `defineObjectType`. Each entry connects this object type (the source) to a
target object type.

```ts
import { defineObjectType, link, prop } from "@sixb/core/ontology"
import { Project } from "./project"
import { Employee } from "./employee"

export const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
  ],
  links: [
    link("project", Project, { cardinality: "one" }),
    link("assignee", Employee, { cardinality: "one" }),
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
| `options` | No | An object for metadata and relationship behavior |

`options` accepts these fields:

| Option | Expected | Meaning |
| --- | --- | --- |
| `name` | `string` | Display name. Defaults to the link `id`. |
| `description` | `string` | Human-readable context for the relationship. |
| `cardinality` | `"one"` or `"many"` | Whether each source links to one or many targets. |
| `properties` | `Property[]` | Metadata stored on each relationship instance. |

## Target forms

The `target` accepts an object type, an object type id string, an array of either, or nothing
(wildcard).

| Form | Example | Points to |
| --- | --- | --- |
| Object type | `link("project", Project)` | One specific type |
| Object type id | `link("project", "Project")` | One specific type, by id |
| Array of types | `link("relatedTo", [Project, Task])` | Any of the listed types |
| Array of ids | `link("relatedTo", ["Project", "Task"])` | Any of the listed types |
| Wildcard (omitted) | `link("anything")` | Any object type |
| Wildcard with options | `link("anything", { cardinality: "many" })` | Any object type |

Passing an object type extracts its `.id` at build time, so `link("project", Project)` and
`link("project", "Project")` produce the same result. Prefer the object-type form — it keeps the
target type-checked and is the source for typed traversal.

When the target is omitted or set to `"*"`, the link is a **wildcard** and can point to any object
type. Prefer a specific target for relationships your app understands; reserve wildcards for
genuinely polymorphic relationships.

## Cardinality

`cardinality` controls how many targets each source object can link to under this link id.

| Value | Meaning |
| --- | --- |
| `"one"` | Each source links to at most one target, like one task belonging to one project. |
| `"many"` | The source can link to multiple targets, like one project having many tasks. |

```ts
link("project", Project, { cardinality: "one" })
link("members", Employee, { cardinality: "many" })
```

## Link properties

A link can carry metadata about the relationship itself — not about either object. Declare these
with `prop(...)`, exactly like object [properties](./properties.md).

```ts
import { defineObjectType, link, prop } from "@sixb/core/ontology"
import { Thermostat } from "./thermostat"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [
    link("hasThermostat", Thermostat, {
      cardinality: "one",
      properties: [
        prop("installedBy", "string"),
        prop("installedAt", "timestamp"),
      ],
    }),
  ],
})
```

Good link properties are facts about the connection: `installedBy`, `installedAt`,
`commissionedBy`, or `confidence`. If a link does not declare `properties`, writing a link with
properties is rejected with an `OntologyValidationError`.

## Create and remove links

Once a type is registered, write links through the typed API on a `byId(...)` handle. The link
token comes from the object type as `Type.l.<linkId>`.

```ts
const rooms = sixb.objects(Room)

// Link to a target by object reference
await rooms.byId("room:101").link(Room.l.hasThermostat, {
  objectTypeId: "Thermostat",
  primaryId: "tstat-9",
})

// With link properties
await rooms.byId("room:101").link(
  Room.l.hasThermostat,
  { objectTypeId: "Thermostat", primaryId: "tstat-9" },
  { properties: { installedBy: "tech-a", installedAt: new Date() } }
)

// Remove a link
await rooms.byId("room:101").unlink(Room.l.hasThermostat, {
  objectTypeId: "Thermostat",
  primaryId: "tstat-9",
})
```

The target is an `ObjectRef` (`{ objectTypeId, primaryId }`). TypeScript checks the target type
against the link's declared target, so linking `hasThermostat` to a `Room` is a compile error.

Writing a link emits a `link.upserted` [event](../events/overview.md); removing one emits
`link.removed`.

## List links from an object

`listLinks(...)` returns the relationship rows for an object, optionally filtered to one link token.

```ts
// All links from this room
const all = await sixb.objects(Room).byId("room:101").listLinks()

// Only hasThermostat links
const thermostats = await sixb
  .objects(Room)
  .byId("room:101")
  .listLinks(Room.l.hasThermostat)
```

## Traverse links in queries

`traverse(...)` follows a link inside an [object query](../objects/querying.md) and changes the
result type to the type on the other end of the link.

```ts
// Outgoing: from a room to its thermostats
const thermostats = await sixb
  .objects(Room)
  .query()
  .where((room) => room.p.id.eq("room:101"))
  .traverse(Room.l.hasThermostat)
  .list()
```

Pass `{ direction: "incoming" }` to walk a link backwards — from the link's target type to its
source type:

```ts
// Incoming: from a customer to the projects that link to it
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
