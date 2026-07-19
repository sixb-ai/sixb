# Ontology Materializer

The Materializer turns source assertions, managed edits, and telemetry points into one effective
Ontology state. It owns semantic planning and commit orchestration; storage providers own durable
state and atomic application.

## Common commit pipeline

```text
normalize + validate intent
  -> derive deterministic identity
  -> verify run and replay
  -> begin serializable materialization session
  -> resolve effective state
  -> diff against committed state
  -> stage deterministic work
  -> apply work in dependency order
  -> write ordered outbox events
  -> finalize commit atomically
```

`staged work` is a transaction-local execution plan. It is not a source materialization and is
never queried as Ontology state.

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
the same semantic commit identity.

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

## Telemetry append

```text
canonical telemetry points grouped by object
  -> compare and plan bounded point chunks
  -> update latest values in the object working state
  -> resolve and diff the effective object once
  -> plan and finalize one batch commit
```

Projection telemetry additionally verifies the durable projection run and records batch progress.
Physical input counts remain distinct from canonical point counts.

## Module boundaries

- `edits/`, `projections/`, `telemetry/`: use-case-specific orchestration and planning.
- `effective/`: pure resolution, validation, diff, and event construction.
- `execution/`: storage-neutral plan execution, replay, retry, and run correlation.
- `shared/`: normalization, identity, batching, and chunking primitives.

Keep use-case entrypoints explicit. Share mechanics only after they have identical semantics; do
not hide projection candidate lifecycle, edit continuation, or telemetry batching behind a generic
workflow engine.
