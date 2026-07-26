# Ontology Materializer

The Materializer turns source assertions, managed edits, and telemetry points into one effective
Ontology state. It owns semantic planning and commit orchestration; storage providers own durable
state and atomic application.

## Ingresses

```text
projection replacement  -> projections.replace
Action edits            -> edits.commit  (mode: "atomic",   origin: action)
runtime object/link     -> edits.commit  (mode: "atomic" | "continue", origin: runtime)
runtime telemetry       -> telemetry.append (origin: telemetry/runtime)
```

`Sixb` constructs one Materializer and threads it through its internal runtime context, so the typed
`objects(...)` SDK, the dynamic `Sixb` methods, and the Action worker all commit through the same
engine. Runtime single calls are atomic; runtime batches use `continue` mode and map per-item
outcomes back to caller positions. No ingress appends domain events or writes object, link, or
timeseries providers directly.

Committed facts are published from the transactional outbox after the commit resolves.
`OntologyOutboxDispatcher` owns that protocol: ingresses call `notify()` for prompt, non-blocking
in-process delivery, and a process may call `start()` to host the durable poll loop. Publication is
best effort — delivery may lag, but a committed fact is never lost.

## Common commit pipeline

```text
normalize + validate intent
  -> derive deterministic identity
  -> verify execution when run-backed and check replay
  -> begin serializable materialization session
  -> resolve effective state
  -> diff against committed state
  -> stage deterministic work
  -> apply work in dependency order
  -> write outbox events with stable commit ordinals
  -> finalize ontology commit atomically
  -> advance a run resume checkpoint when required
```

`staged work` is a transaction-local execution plan. It is not a source materialization and is
never queried as Ontology state.

## Durable ownership

```text
run storage       -> execution ownership, lifecycle, progress, and resume checkpoints
ontology storage  -> sources, effective state, telemetry, commits, and outbox
Materializer      -> semantic planning and cross-store transaction orchestration
```

Ontology commit `origin` is the canonical correlation to an Action or projection run. Run records
do not duplicate ontology commit ids or semantic commit history. Replacement projections need no
resume checkpoint; projection telemetry stores only its next batch/row checkpoint on the run.

Logical origins are unique in the ontology ledger: one commit per Action run, one per replacement
run, and one per telemetry run/batch ordinal. Exact origin lookup is used for correctness; commit
listing is reserved for history and observability.

## Projection replacement

```text
dataset entries
  -> staging source candidate
  -> ready source candidate
  -> compare candidate + overrides + telemetry with effective state
  -> plan and apply changes
  -> atomically activate candidate and finalize commit
```

Source ingress is sealed before commit time is assigned. A retry reuses the ready candidate and
the same semantic commit identity. Activation and ontology commit finalization are atomic; the
projection run stores no separate commit pointer.

Projection runs finish only through `projections.finishRun(...)`. Its serializable transaction reads
the authoritative ontology commit before replacement success, rejects failure after commit, and
then applies the fenced run transition.

## Managed edits and Actions

```text
ordered edit operations
  -> transaction-local EditWorkingState
  -> update object/link overrides
  -> validate effective objects, endpoints, and cardinality
  -> diff final working state against commit-start state
  -> plan and finalize one commit
```

`EditWorkingState` is not durable. Its original snapshots remain pinned to the commit start, while
its mutable overrides let operation N+1 observe operation N. In `continue` mode, a rejected
operation rolls back only its working override; provider and infrastructure failures abort the
whole transaction.

Action-backed edits verify the matching running Action before work and again inside the commit
transaction. Their semantic result lives only in the ontology commit, correlated by Action origin;
the Action run is not a second commit ledger.

## Telemetry append

```text
canonical telemetry points grouped by object
  -> compare and plan bounded point chunks
  -> update latest values in the object working state
  -> resolve and diff the effective object once
  -> plan and finalize one batch commit
```

Projection telemetry additionally verifies the durable projection execution and advances its
resume checkpoint in the same transaction as ontology commit finalization. The ontology commits
are the authoritative batch ledger. Physical source-row counts, including skipped rows, remain
distinct from canonical point counts.

Telemetry success requires an exhausted checkpoint. A truly empty immutable input is completed
explicitly without manufacturing an ontology batch commit; the empty checkpoint transition and run
finish still commit atomically.

## Module boundaries

- `edits/`, `projections/`, `telemetry/`: use-case-specific orchestration and planning.
- `effective/`: pure resolution, validation, diff, and event construction.
- `execution/`: storage-neutral plan execution, replay, retry, and run correlation.
- `shared/`: normalization, identity, batching, and chunking primitives.
- `storage/ontology/`: durable ontology commit, source, materialization, and outbox contracts.

Keep use-case entrypoints explicit. Share mechanics only after they have identical semantics; do
not hide projection candidate lifecycle, edit continuation, or telemetry batching behind a generic
workflow engine.
