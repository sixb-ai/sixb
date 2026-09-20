# Source ordering

Use `sequenceBy` to keep the newest source record when changes arrive out of order:

```ts
import { col, defineDataset } from "@sixb/core"

export const people = defineDataset("crm.people", {
  schema: [col("id", "string"), col("name", "string"), col("updatedAt", "timestamp")],
  primaryKey: "id",
  sequenceBy: "updatedAt",
})
```

Use the **source's** revision or timestamp, not fetch/receipt time. [Syncs](../syncs/overview.md) and [webhooks](../connectors/webhooks.md#webhooks-updating-source-datasets) submit complete rows or sequenced deletes:

```ts
import { change } from "@sixb/core"

change.upsert({ id: "42", name: "Sam", updatedAt: "2026-09-09T10:00:00.123Z" })
change.delete({ id: "42" }, { sequence: "2026-09-09T10:01:00.000Z" })
```

## Merge behavior

| Incoming change | Result |
| --- | --- |
| Newer sequence | Applies |
| Older sequence | Ignored |
| Equal sequence, identical content | Unchanged |
| Equal sequence, different content or upsert/delete tie | Entire merge fails |
| Delete v9 → upsert v8 → upsert v10 | Stays deleted at v8; restored at v10 |

Repeated keys are processed in submission order. Deletions retain durable ordering state, even for
absent keys; new deletion state creates a version without requiring a visible row change.

## Sequence values

| Column type | Accepted values |
| --- | --- |
| `int64` | Signed 64-bit integers. Use decimal strings outside JavaScript's safe integer range. |
| `timestamp` | Valid `Date` or ISO timestamp with `Z`/`±HH:MM` and at most 3 fractional digits. Equivalent instants compare equally. |

## V1 constraints

- **Snapshot syncs reconcile.** Returned rows become ordered upserts; omitted keys stay. Deletion requires a sequenced delete.
- **Empty snapshots initialize.** A first successful snapshot creates an addressable version even
  with no rows. Later empty snapshots reuse the existing version and retain its rows.
- **Bounded retries.** Sequenced writes retry known concurrency conflicts up to 3 total attempts, reusing staged changes without re-fetching. Explicit version guards stay strict.
- **SQL pipeline output.** SQL transforms cannot write to sequenced datasets; use a separate output dataset.
- **Immutable configuration.** Create a new dataset and backfill to adopt or change `sequenceBy`.
- **Explicit derivation.** Derived datasets must declare their own `sequenceBy` and primary key.

For content equality, object-key order is ignored; array order matters. Nullable columns treat
omitted, `undefined`, and `null` equally. Integer, decimal, date, and timestamp columns use canonical values.
On a sequenced dataset, **every timestamp column** must use a valid `Date` or timezone-explicit
ISO string with at most 3 fractional digits, including columns other than `sequenceBy`. Higher
precision is rejected before staging so content comparison never silently discards it.
