# Lineage

Lineage answers "where does this value come from?" for an object as it is now: the dataset row a
projection imported, the action or write that edited it, or the telemetry point that set it.
Nothing extra is stored; Sixb assembles it when you ask.

## Explain an object

```ts
import { Customer } from "./ontology/customer"

const lineage = await sixb.objects(Customer).lineage("42")
```

It returns `null` when the caller cannot read the object. Each source is described once in
`sources`; `existence` and every property point at one by its key:

```ts
{
  existence: { source: "projection:customers" },
  sources: {
    "projection:customers": {
      kind: "projection",
      projectionId: "customers",
      projectionRunId: "prj_run_12",
      datasetVersion: { datasetId: "crm.customers", versionId: "ducklake:84" },
      rowOrigins: [{ datasetId: "raw.crm.contacts", column: "active" }],
    },
    "commit:cmt_91": {
      kind: "edit",
      commitId: "cmt_91",
      committedAt: "2026-10-30T09:12:44.120Z",
      requestedBy: { type: "user", id: "usr_alice" },
      action: { actionId: "rename-customer", runId: "run_7" },
    },
    identity: { kind: "identity" },
  },
  properties: {
    id: { source: "identity" },
    email: {
      source: "projection:customers",
      column: "email",
      origins: [{ datasetId: "raw.crm.contacts", column: "mail" }],
    },
    name: {
      source: "commit:cmt_91",
      replaced: { source: "projection:customers", column: "name", value: "ACME" },
    },
  },
  restricted: 0,
}
```

| `kind` | The value comes from | It names |
| --- | --- | --- |
| `projection` | a projection's source row | the projection, its run, the dataset version applied, and the columns that decide its rows |
| `edit` | an action or a direct write | the commit, when and for whom it ran, and the action run |
| `telemetry` | the latest telemetry point | the commit that appended it |
| `identity` | the primary key | nothing more |

A property also gives the value it won over (`replaced`), the times compared under
[`mostRecent`](../projections/overview.md#source-updates-and-app-edits) (`resolution`), and
`removed: true` when its source cleared it. `origins` are the upstream dataset columns its values
come from. The columns that decide which rows exist (filters, join keys, everything a code step
reads) concern every value, so the projection source lists them once, as `rowOrigins`.

## Explain a link

```ts
const lineage = await sixb.objects(Customer).linkLineage({
  sourceId: "42",
  linkId: "owner",
  targetTypeId: "User",
  targetId: "usr_7",
})
```

`existence` cites the projection and the `columns` it reads the link from, or the edit that set it.

## Walk a dataset version upstream

```ts
const upstream = await sixb.datasets.lineage(customers, { versionId: "ducklake:84", depth: 5 })
```

It returns the version and the versions it was computed from, nearest first, as `nodes` with their
producer and `edges` between them. `versionId` defaults to the latest version; `depth` goes from 1
to 20 and defaults to 5. `truncated` says the walk stopped at `depth` or at 100 versions.

## What the caller sees

- Each step is checked on its own. A step the caller cannot view is left out, without saying what
  it was, and counted in `restricted`.
- A property the caller is not cleared for is not explained. See [Markings](../auth/markings.md).
- A dataset version, its columns, `origins` and `rowOrigins` need a view grant on that dataset; a
  projection, sync or pipeline run shows to whoever may view those runs; an action run to whoever
  may view it.
- A [shared link](../auth/shared-access.md) sees no lineage.

## Limits

- Lineage describes the current state only, not how a value changed over time.
- Two edits committed in the same millisecond can leave the commit unknown: `commitId` is `null`
  and the source is keyed `commit@<instant>`.
- An upstream version the lake no longer holds, for example after a cleanup, is marked
  `expired: true` and not walked further; columns read from it give no `origins`.
