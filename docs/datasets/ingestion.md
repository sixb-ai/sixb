# Ingesting changes

Webhook handlers and other trusted backend code can update a registered dataset with a primary key.
This example uses the [`people` dataset](source-ordering.md):

```ts
import { change } from "@sixb/core"
import { people } from "../datasets/people"

await sixb.datasets.ingest(people, {
  changes: [
    change.upsert({ id: "42", name: "Sam", updatedAt: "2026-09-09T10:00:00.123Z" }),
    change.delete({ id: "9" }, { sequence: "2026-09-09T10:01:00.000Z" }),
  ],
})
```

`ingest` validates the changes and stores them. It returns once they are stored, before they are
in the dataset. A worker then writes the changes waiting for the dataset as one new version, usually
within a second, so many webhooks give a few versions instead of one each.

| Contract | Behavior |
| --- | --- |
| Input | Iterable or async iterable of complete-row upserts and primary-key deletes |
| Cancellation | Optional `signal: AbortSignal`, until the changes are stored |
| Validation | Registered schema, primary key, source sequence, and referenced blobs; errors throw from `ingest` |
| Result | `{ deliveryId, changes }`: the id that names this call's changes in failure reports (`null` when there were none), and their count |
| Order | Changes apply in the order `ingest` calls stored them, as one call after another would |
| Downstream work | Each new version emits `dataset.version.committed`; pipelines and projections run asynchronously |
| Authority | Trusted backend executions, or explicitly disabled authorization; dataset-view grants do not permit ingestion |

Use [`sequenceBy`](source-ordering.md) when webhooks and syncs share a dataset.

| Dataset | Concurrent writes | Snapshot sync |
| --- | --- | --- |
| With `sequenceBy` | Newer source values win | Ordered upserts; omitted rows stay |
| Without `sequenceBy` | The later write wins | Replaces rows |

**Existing unkeyed dataset?** Create a new keyed dataset → backfill → repoint consumers.
Stored primary keys and `sequenceBy` are immutable.

For bulk loads, use a [sync](../syncs/overview.md): `ingest` keeps each call in the database until a
worker writes it.

## React to new data

Code that needs the ingested data does not wait for `ingest`. Trigger it from the new version
instead, here a sync that reads the dataset:

```ts
import { defineSchedule, events } from "@sixb/core"
import { people } from "../datasets/people"

export const peopleUpdated = defineSchedule("people-updated").on(events.dataset(people).updated())
```

Attach it to the sync, pipeline or workflow with `.when(peopleUpdated)`. It fires for versions that
changed rows, and a burst of them joins one waiting run.

## Objects and relationships

Ingestion updates source data. Existing pipelines and projections determine the object result:

| Change | Downstream behavior |
| --- | --- |
| Source record updated | Pipeline recalculates merged data; projection updates its properties and links |
| Application edit | Projection's [conflict policy](../projections/overview.md#source-updates-and-app-edits) still applies |
| Source row removed | Projection withdraws its claims; the ontology object is not automatically deleted |
| Foreign-key target missing | Properties can materialize, but no edge is created; the old source-owned link is withdrawn |

## Where it runs and what can fail

- The `lake` worker writes ingested changes. `sixb dev` and `sixb worker-group` include it; a
  deployment that names its worker `types` must list `lake`, and `sixb deploy` warns when it does
  not.
- Changes reach the lake with no orchestrator running. Keep it on all the same: it recovers the
  failures below and reports changes that wait.
- Console › Lake health shows the changes still waiting per dataset, and since when.
- A worker that stops while writing resumes where it stopped, and never writes changes twice.

| Failure | What happens |
| --- | --- |
| The lake or blob storage is unavailable | Retried until it succeeds; `dataset.ingest.flush.failed` reaches `onError` at the fifth failure in a row |
| The queue refuses the write | `ingest` still succeeds: the changes are stored, and the orchestrator asks again within 30 seconds |
| Changes wait 10 minutes and nothing writes them | The orchestrator reports `dataset.ingest.flush.failed` to `onError` |
| A stored change is refused when written: no longer valid for the schema, a deleted blob, a value the lake cannot hold, or a source sequence another call holds with other content | That call's changes are dropped and `dataset.ingest.rejected` names it and the refused change; the other calls' changes are written |
