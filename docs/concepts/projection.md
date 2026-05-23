# Projection

A projection maps committed dataset versions into typed objects and links in the twin graph.

Projection authoring lives in `@sixb/core`. Projection execution lives in
`@sixb/projection-worker`.

## What It Does

- maps dataset columns to object type properties;
- derives object primary ids from the mapped primary property;
- resolves foreign key columns into ontology links;
- materializes many-to-many join datasets into links;
- records run status and aggregate counters in `ProjectionRunStorage`.

## Parts

| Piece | Role |
| --- | --- |
| `defineDataset` / `col` | Typed dataset contract used by syncs, pipelines, and projections |
| `defineProjection` | Fluent builder for object projections |
| `defineLinkProjection` | Fluent builder for many-to-many link projections |
| `fromForeignKey` | Type-safe FK descriptor tying a link, a source property, and a target type |
| `OrchestratorWorker` | Routes `dataset.version.committed` events to `queues.projections` |
| `ProjectionWorker` | Reads committed dataset versions and writes objects/links through `objectService` |
| `ProjectionRunStorage` | Stores run status and counters |

## Define a Dataset

File: `datasets/erp.ts`

```ts
import { col, defineDataset } from "@sixb/core"

export const erpCustomersDataset = defineDataset("erp.customers", {
  schema: [
    col("customer_id", "string"),
    col("contact_name", "string"),
    col("contact_email", "string"),
    col("company_name", "string"),
    col("industry_sector", "string"),
    col("service_tier", "string"),
    col("account_mgr_id", "string"),
  ],
})
```

Projection builders receive the dataset definition directly, not a string id. The lowered projection definition remains serializable and stores `datasetId`.

## Define an Object Projection

File: `projections/customer-projection.ts`

```ts
import { defineProjection, fromForeignKey } from "@sixb/core"
import { erpCustomersDataset } from "../datasets/erp"
import { Customer } from "../ontology/customer"
import { Employee } from "../ontology/employee"

export const customerProjection = defineProjection("customer-proj", Customer)
  .fromDataset(erpCustomersDataset)
  .properties({
    id: "customer_id",
    name: "contact_name",
    email: "contact_email",
    company: "company_name",
    industry: "industry_sector",
    tier: "service_tier",
    accountManagerRef: "account_mgr_id",
  })
  .withLinks({
    accountManager: fromForeignKey({
      link: Customer.l.accountManager,
      sourceProperty: Customer.p.accountManagerRef,
      target: Employee,
    }),
  })
```

`.properties(...)` is type-safe:

- keys must be property ids on the object type;
- values must be column names on the dataset;
- mapped dataset column types must be compatible with the property schema;
- the primary property must be mapped.

`fromForeignKey(...)` is also type-safe:

- the link and source property must belong to the same object type;
- the target object type must match the link target, or be a compatible subtype.

At runtime, the FK column value is used as the target object's primary id.

## Define a Link Projection

For many-to-many relationships stored in a join dataset:

```ts
import { defineLinkProjection } from "@sixb/core"
import { erpProjectMembersDataset } from "../datasets/erp"
import { Project } from "../ontology/project"

export const projectMembersProjection = defineLinkProjection("project-members", Project.l.members)
  .fromDataset(erpProjectMembersDataset)
  .sourceField("project_id")
  .targetField("employee_id")
```

Link projection source and target fields must be string dataset columns. Polymorphic and wildcard link targets are rejected for V1.

## Runtime Flow

Projection execution is driven by committed dataset versions:

```text
sync or pipeline writes rows
  -> LakeStorage commits a dataset version
  -> events emits dataset.version.committed
  -> OrchestratorWorker enqueues projection.run.requested
  -> ProjectionWorker reads the exact dataset version
  -> objectService upserts objects and links
  -> ProjectionRunStorage records counters and status
```

The Orchestrator matches projections by `projection.datasetId`. The Projection Worker executes the projection named by the queued job; it does not resolve projection dependencies itself.

## Hosting Workers

`sixb dev` starts the projection worker automatically when projection definitions are registered.
No manual worker setup is needed for normal local development.

Custom hosts can still start both workers explicitly:

```ts
import { compileRoutes, OrchestratorWorker } from "@sixb/orchestrator"
import { ProjectionWorker } from "@sixb/projection-worker"

const routes = compileRoutes({
  syncs: sixb.getSyncDefinitions(),
  pipelines: sixb.getPipelineDefinitions(),
  projections: [...sixb.getObjectProjections(), ...sixb.getLinkProjections()],
})

const orchestrator = new OrchestratorWorker({
  projectId: sixb.id,
  events: sixb.events,
  queues: sixb.queues,
  routes,
})

const projectionWorker = new ProjectionWorker(sixb)

await orchestrator.start()
await projectionWorker.start()
```

Start the orchestrator before emitting dataset commit events. The V1 orchestrator is live-only and does not catch up on events emitted before startup.

## Inspect Runs

Projection runs are stored by `ProjectionRunStorage`:

```ts
const result = await sixb.storage.projectionRuns?.list({
  projectId: sixb.id,
  projectionId: "customer-proj",
  statuses: ["succeeded", "failed"],
  limit: 20,
})
```

Each `ProjectionRunRecord` includes:

```ts
{
  id: string
  projectionId: string
  projectionKind: "object" | "link"
  datasetId: string
  datasetVersionId: string
  status: "running" | "succeeded" | "failed" | "cancelled"
  rowsProcessed: number
  rowsSkipped: number
  objectsUpserted: number
  linksUpserted: number
  errorMessage?: string
}
```

V1 stores aggregate counters and one terminal error message. Detailed per-row diagnostics can be added later if needed.

## Convention

Export projection definitions from `projections/`:

```txt
your-project/
  datasets/
    erp.ts
  ontology/
    customer.ts
    employee.ts
    project.ts
  projections/
    customer-projection.ts
    project-projection.ts
    project-members-projection.ts
  sixb.config.ts
```

`createSixb()` scans `datasets/` and `projections/` and registers exported definitions automatically.

You can also register projections explicitly:

```ts
createSixb({
  datasets: [erpCustomersDataset],
  projections: [customerProjection],
})
```

Startup validation checks projections against registered datasets and ontology:

- referenced dataset exists;
- projected object type exists;
- mapped properties and dataset columns exist;
- mapped column types are compatible with property schemas;
- primary property is mapped;
- FK links reference valid links, mapped source properties, and compatible target types;
- link projection source and target object types exist and have primary properties.

## Guidelines

- Keep one projection focused on one object type and one dataset.
- Use `fromForeignKey()` for one-to-one and many-to-one relationships stored as columns.
- Use `defineLinkProjection()` for many-to-many relationships stored in join datasets.
- Pass dataset definitions to `.fromDataset(...)`, not string ids.
- Commit datasets to `LakeStorage`; do not build ad hoc row sources.
- Keep projection run storage enabled when hosting `ProjectionWorker`.

## V1 Limits

- Set-only: missing dataset rows do not delete existing objects or links.
- Latest write wins: user edits and projection writes both go through object service.
- Batch materialization is not globally transactional across object storage writes.
- No manual CLI/API projection run trigger yet.
