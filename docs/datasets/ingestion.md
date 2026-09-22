# Ingesting changes

Webhook handlers and other trusted backend code can update a registered dataset with a primary key.
This example uses the [`people` dataset](source-ordering.md):

```ts
import { change } from "@sixb/core"
import { people } from "../datasets/people"

const result = await sixb.datasets.ingest(people, {
  changes: [
    change.upsert({ id: "42", name: "Sam", updatedAt: "2026-09-09T10:00:00.123Z" }),
    change.delete({ id: "9" }, { sequence: "2026-09-09T10:01:00.000Z" }),
  ],
})
```

| Contract | Behavior |
| --- | --- |
| Input | Iterable or async iterable of complete-row upserts and primary-key deletes |
| Cancellation | Optional `signal: AbortSignal` |
| Validation | Registered schema, primary key, source sequence, and referenced blobs |
| Result | `{ outcome: "created" \| "unchanged", version, rowsRead }`; `version` can be `null` for an initial no-op |
| Downstream work | New versions emit `dataset.version.committed`; pipelines/projections run asynchronously |
| Authority | Trusted backend executions, or explicitly disabled authorization; dataset-view grants do not permit ingestion |

Use [`sequenceBy`](source-ordering.md) when webhooks and syncs share a dataset.

| Dataset | Concurrent writes | Snapshot sync |
| --- | --- | --- |
| With `sequenceBy` | Newer source values win; concurrency conflicts retry | Ordered upserts; omitted rows stay |
| Without `sequenceBy` | A concurrent version change fails ingestion | Replaces rows |

**Existing unkeyed dataset?** Create a new keyed dataset → backfill → repoint consumers.
Stored primary keys and `sequenceBy` are immutable.

## Objects and relationships

Ingestion updates source data. Existing pipelines and projections determine the object result:

| Change | Downstream behavior |
| --- | --- |
| Source record updated | Pipeline recalculates merged data; projection updates its properties and links |
| Application edit | Projection's [conflict policy](../projections/overview.md#source-updates-and-app-edits) still applies |
| Source row removed | Projection withdraws its claims; the ontology object is not automatically deleted |
| Foreign-key target missing | Properties can materialize, but no edge is created; the old source-owned link is withdrawn |

## Recovery

A crash can leave data saved without notifying downstream work. Automatic notification recovery
is not available.

- Notification failures are reported through `onError`.
- Identical sequenced retries are no-ops; they do not resend notifications.
- Rerun the downstream pipeline after missed notifications or pipeline failures:

```ts
await sixb.pipelines.request({ pipelineId: "merge-contacts" })
```
