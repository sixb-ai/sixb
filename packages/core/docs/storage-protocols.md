# Storage protocols

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## Broker vs queues

The two messaging slots are **not** the same thing — keep them distinct.

| | Broker | Queues |
| --- | --- | --- |
| Shape | Append-only event log | Lease-based work lanes |
| Purpose | Records what happened, fans out to subscribers | Dispatches and retries background jobs |
| Operations | `append`, `read`, `latestCursor`, `subscribe` | `enqueue`, `claim`, `complete`, `retry`, `fail`, `renewLease` |
| Carries | Domain [events](../../../docs/events/overview.md) (`object.created`, `object.updated`, `telemetry.appended`, `link.created`, `action.requested`, …) | Run requests, one per lane |
| Replayable | Yes — retained, ordered history | No — jobs are consumed |

For ontology facts, the operational database is authoritative: the Materializer writes
`ontology_commits` and `ontology_outbox` atomically before best-effort broker publication. The
broker is the retained delivery/read surface, while queues turn requested work into running work
with leases and retries. The `queues` provider
exposes one lane per kind of background work:

```ts
sixb.queues.actions
sixb.queues.syncRuns
sixb.queues.pipelines
sixb.queues.projections
sixb.queues.workflows
```

Storage providers must preserve bounded outbox claims, lease-fenced settlement, retry summaries,
published-row retention, and child-first cleanup of terminal source materializations. Pending rows,
nonterminal sources, and `ontology_commits` are never removed by age.

`ObjectStorage` and `TimeseriesStorage` are read models. Actions, runtime CRUD, projections, and
telemetry all write through the Materializer and its private `OntologyStorage.materializations`
protocol. Providers must not expose an event-to-row writer or interpret domain events as storage
commands.

The required `storage.ping()` readiness check must be lightweight and read-only. It must not open a
write transaction, run migrations, or acquire a migration/advisory lock. Schema validation is a
separate cached check and retries failures with a cooldown.

## Retention tables

The API role purges expired rows every 60 seconds, in the same maintenance pass that
catches the outbox up.

| Table                  | Purged                                     | Default |
| ---------------------- | ------------------------------------------ | ------- |
| `ontology_outbox`      | published rows                             | 24 h    |
| `ontology_source_rows` | the rows of a terminal materialization     | 24 h    |
| `ontology_sources`     | its manifest, once those rows are gone     | 24 h    |
| `ontology_commits`     | **nothing** — it grows with every commit   | —       |

Pending outbox rows and nonterminal sources are live data and are never purged by age.
Size the disk with `ontology_commits` in mind: the pre-0.1 line has no purge for it.

## Sequenced dataset writes

Direct snapshot/append sessions and SQL-transform writes to sequenced datasets are rejected. Writes use the merge path to preserve source ordering.

## Incremental projection materialization

With DuckLake or InMemoryLakeStorage, object and link projections compare pinned dataset versions
and recompute changed roots, including their FK links. Unchanged source values remain available
for conflict resolution and resets. Retention removes only retired root versions.

The first run, changed definitions, unavailable snapshots, or ambiguous identities use a complete
replacement with the same validation rules. Comparing snapshots can still scan the dataset;
incremental materialization does not imply incremental ingestion. Telemetry keeps its batch protocol.

Atlas reports **Changes read** for incremental attempts and **Rows read** for complete reads.
These counters describe input work, not the number of published objects or a recovery cursor.
Unchanged roots are excluded from an incremental run’s commit counts.
