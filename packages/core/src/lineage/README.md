# Object lineage

`sixb.objects(T).lineage(id)` and `.linkLineage(input)` answer, for the current state, where a
value comes from. Nothing here is stored: a lineage is assembled on read from facts the
materializer already keeps, and it describes only the present, not a history.

## Mechanism

```text
AuthorizedObjectReader.getByPrimaryIdBatch    readable? which properties are redacted?
  -> materializations.readState               source row, override + edit times, effective row,
                                              latest telemetry — one consistent snapshot
  -> explainEffectiveObject                   the materializer's own resolution, recording what
                                              decided existence and each property
  -> read what the decisions cite, together   active source + its dataset version, the commits
                                              behind edits and telemetry, their executions and
                                              Action runs
  -> assemble                                 sources described once, properties pointing at them
```

The explanation comes from the code that computes effective values: `effective/resolve.ts` decides
and records in one function, and `resolveEffectiveObject` is that function without a recorder. A
link goes through `resolveEffectiveLink` or `resolveEffectiveLinkSlotMember`, by cardinality, with
the same kind of recorder.

| Authority             | Source cited                                                              |
| --------------------- | ------------------------------------------------------------------------- |
| Projection source row | `projection:<id>`: the active materialization's run and dataset version   |
| Action or direct edit | `commit:<id>` (or `commit@<instant>` when it cannot be told apart)        |
| Latest telemetry      | `telemetry:<commitId>`: the commit that appended the point                |
| Primary key           | `identity`                                                                |

A projection source cites the projection's **active** materialization, even when a delta kept the
row on an older one: the row is identical in the active version, and `lake cleanup` keeps active
versions. A property's column is read from the projection's current definition (`properties`,
which holds `ref.user()` columns too; a foreign key's `sourceField` or source property for a
projected link; `sourceField`/`targetField` for a link projection), and its `origins` from the
version's recorded column lineage (`lake-storage/lineage.ts`).

## Finding the commit behind an edit

Nothing records which commit wrote a property. The override records each edited property's time,
and that time **is** the edit commit's `committedAt` (`applyObjectEditTimes` copies it; the
materializer storage contract fails if it stops). So the commit is one of the commits at that
instant (`commits.list({ committedAt })`, one read per distinct instant):

1. the edit commit whose effective change of this object holds this property (for a property), or
   creates the object (for the existence of an object only an edit created, found at its
   effective `createdAt`);
2. otherwise the only edit commit at that instant;
3. otherwise unknown: `commitId: null`, keyed `commit@<instant>`.

Matching the change, not just the object, keeps apart two writes of one object in the same
instant. An edit that changed nothing effective (it set the value already there, or it lost to a
newer source row) holds no change, hence step 2. An override written before edit times were
recorded has no time for the property: its `lastCommitId` is the override's last writer, not
necessarily the property's, so the commit is unknown, keyed at the override's `updatedAt`. A link
override cites its `lastCommitId`, exactly: the override holds that one link.

## Authorization

Each step is authorized on its own with the guard that protects it elsewhere. A step the reader
cannot view is left out without its identity and counted once in `restricted`.

| Step                         | Shown when                                                          |
| ---------------------------- | ------------------------------------------------------------------- |
| The object                   | the `AuthorizedObjectReader` reads it: view conditions, markings    |
| A property                   | the reader has its clearance; otherwise it is not explained at all  |
| A link                       | both objects are readable and the link's markings allow it          |
| Requester                    | the object is readable, as in the object's events                   |
| Executor and `action`        | the reader may view the run the executor names (below)              |
| Projection run               | `canViewProjectionRun` on the projection's target                   |
| Dataset version, columns     | `view:dataset` on that dataset, `rowOrigins` included               |
| An origin dataset            | `view:dataset` on that dataset                                      |

An executor that names a run shows only when the run's facade would show that run:
`viewableActionRuns` and `canReadActionRunSubject` for an Action, the thread access rule for an
Agent run, `canViewPrimitiveRun` (`authorization/run-visibility.ts`) for every other primitive.
Rules and webhooks have no run facade, so their runs stay closed. A request or a kernel operation
names no run and always shows. An Action commit runs under its run's execution, so its `action`
shows with its executor.

Denied and delegated (shared link) authority see no lineage, as they see no run.

## Reads

One `readState`, one `getActive` and one `getVersion` for the projection, one commit list per
distinct edit instant, one `getById` per commit named exactly, one `getById` per distinct
execution, and one read per distinct Action or Agent run an executor names. Nothing is read per
property.

Commit lookups load whole commit records, `result.changes` snapshots included: an object written
by a large bulk commit pays for that commit's size.

## Limits

- Columns come from the current definition. A definition changed since the active version was
  applied, and not yet rerun, shows its new columns; one that now reads another dataset shows none.
  A projection removed from the code shows what storage says, without columns.
- A property's `origins` list the columns whose values flow into its column. The columns that
  decide which rows exist (`DatasetColumnLineage.rows`: filters, join keys, everything a `run`
  step reads) are every value's, so they are described once, as the projection source's
  `rowOrigins`; `origins: []` means no column beyond those. Both are absent when the version
  records no lineage, records one Sixb cannot read, or is no longer in the lake, and `origins`
  when the lineage does not list the column.
- Two edit commits at one instant that both change the property, or none of several, leave the
  commit unknown.
