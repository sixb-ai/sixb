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

`SixbHost` owns one unbound Materializer. `withScope(...)` closes its mutation port over one validated execution before the typed `objects(...)` SDK or a trusted worker can use it. The host never exposes a raw mutation port. Runtime single calls are atomic; runtime batches use `continue` mode and map per-item outcomes back to caller positions. No ingress appends domain events or writes object, link, or timeseries providers directly.

Committed facts are published from the transactional outbox after the commit resolves.
`OntologyOutboxDispatcher` owns that protocol: ingresses call `notify()` for prompt, non-blocking
in-process delivery; `OntologyMaintenance` hosts recovery catch-up. Publication is
best effort — delivery may lag, but a committed fact is never lost.

## Common commit pipeline

```text
normalize + validate intent
  -> derive deterministic identity
  -> validate the execution/authority binding
  -> persist or verify the durable execution
  -> verify run ownership when run-backed and check replay
  -> begin serializable materialization session
  -> resolve effective state
  -> diff against committed state
  -> stage deterministic work
  -> storage applies the work in dependency order and writes its outbox events
  -> finalize ontology commit atomically
  -> advance a run resume checkpoint when required
```

Staged work is an execution plan, never queried as Ontology state. Edits and telemetry stage it on
their session; a projection replacement stages it on the candidate's durable plan (below). Either
way the Materializer plans and storage applies: it validates cardinality, writes every item in
phase order and sequences the events, so planned rows are not read back to be sent again. Vector
profiles see the changed objects first, while those still hold their previous values.

## Durable ownership

```text
run storage       -> execution ownership, lifecycle, progress, and resume checkpoints
ontology storage  -> sources, replacement plans, effective state, telemetry, commits, and outbox
Materializer      -> semantic planning and cross-store transaction orchestration
```

Every ontology commit references its immutable execution through `executionId`. Storage providers enforce that reference. `origin` remains the semantic idempotency and run-correlation key: it says which runtime request, Action, projection replacement, or telemetry batch the commit represents; the execution says under which durable authority it ran. Neither field duplicates the other.

Every event of a commit also names who asked for it and what wrote it, so consumers can answer "who changed this" without reading the execution: `requestedBy`, the principal on whose behalf the execution chain runs (absent for automatic, anonymous, or auth-disabled work), `executor`, the request, primitive run, Agent run, or kernel operation that wrote, and `correlationId`. The commit does not copy them: they live once, on its immutable execution, and the outbox reads them there. Authority stays on the execution's `authorizationRef`; only a primitive's id is read from it. Before writing, the Materializer requires an Action or projection origin to name the exact primitive run of its execution (`assertTrustedPrimitiveMutationExecution`).

Storage keeps an event once, as its draft — its type and payload, without the property changes a creation only restates. When the outbox claims a row, it rebuilds the full event from the draft, its commit and that commit's execution (`materializationEvent`). An event therefore cannot disagree with its commit or its execution, and a large publication writes their context once instead of once per event.

Run records do not duplicate ontology commit ids or semantic commit history. Replacement projections need no resume checkpoint; projection telemetry stores only its next batch/row checkpoint on the run.

Logical origins are unique in the ontology ledger: one commit per Action run, one per replacement
run, and one per telemetry run/batch ordinal. Exact origin lookup is used for correctness; commit
listing is reserved for history and observability.

## Projection replacement

```text
dataset entries
  -> staging source candidate
  -> ready source candidate
  -> plan the candidate, outside any transaction, page by page
  -> commit transaction: refresh the plan, apply it, activate the candidate, finalize the commit
```

Source ingress is sealed before commit time is assigned. Activation and ontology commit
finalization are atomic; the projection run stores no separate commit pointer.

The plan is built outside the commit transaction, which refreshes it, then applies it. The plan is
durable and belongs to the candidate:

```text
open      -> the candidate's identities: its entities and those of the roots it replaces
plan      -> each page reads its state in one snapshot, records the revision of what it read,
             and stages the resulting work; links are planned after objects, then extended to
             the links of newly planned objects whose existence flips and to the members of
             newly changed scopes
refresh   -> in the commit transaction: a planned identity whose inputs a commit touched since
             is planned again, with the links that commit brought into the plan; a few are
             planned right there, more are given back to a round outside the transaction
apply     -> only a plan that refresh found fresh; the commit reports its planned counts
```

An identity's revision covers everything its plan read: an object's effective row, override and
latest telemetry; a link's effective row, edge and slot overrides, live source, and the existence
of both endpoints (the whole revision of an endpoint the plan decides, whose planned existence
follows it).

Every commit records the entities whose plan inputs it changed, its touches: the objects whose row,
override or telemetry it wrote, the links whose row or edge override it wrote or whose live source
assertion its activation moved, and the scopes whose slot override it wrote. When no commit of the
project landed since the plan last proved fresh, refresh checks nothing; otherwise it reads again
only the revisions of identities those commits touched (a link also through its scope and both
endpoints), so its cost follows the commits, not the plan. A plan older than the touches storage
still keeps (PostgreSQL purge can race a plan's opening) is checked whole.

A refresh that finds no more stale identities than `transactionReplanRows` (one state page) plans
them inside the commit transaction, where nothing changes them again, and commits. More are given
back to another round outside it. A commit that keeps finding many stale identities gives the
delivery back after three rounds; the next delivery resumes the same plan, as does any redelivery
of the run, unless the active source the plan replaces moved meanwhile: the plan then starts over.
Storage keeps a plan while its candidate is ready and maintenance deletes it afterwards, before the
candidate itself, along with the touches no ready plan still needs.

The commit time is fixed when the plan opens: every planned row carries it as `updatedAt`, every
planned event as `occurredAt`. A resumed plan keeps it, so a publication that commits later than
it opened, after retries, stamps its writes with that earlier time, even over an edit committed in
between. Commit order is the order of the ontology ledger and the outbox, never these timestamps.

A candidate belongs to its run, not to the delivery that staged it:

```text
delivery fails transiently -> candidate stays with the run
next delivery              -> adopts it: ready is published as is, staging resumes at its last root
run ends without success   -> finishRun abandons it in the same transaction
maintenance                -> deletes abandoned candidates whole, without retention
```

An adopted candidate staged against another delta base is abandoned and replaced, since its roots
describe a different change. Staging resumes by reading the entries again from the start, which is
sound because they are deterministic for the pinned dataset version and definition.

Projection runs finish only through `projections.finishRun(...)`, including a failure found before
materialization began. Its serializable transaction reads the authoritative ontology commit before
replacement success, rejects failure after commit, releases the run's candidate, and then applies
the fenced run transition. Success must match the deployed definition; failure only has to hold
the run's execution token, so a run pinned to a definition a deploy has since replaced can still
end.

A replacement run ends `superseded`, without materializing, when a run of the same projection
pinned to a later dataset version is queued, running, or succeeded. The worker checks this on every
delivery after its claim; `finishRun` checks it again under its transaction, since a newer run that
failed in between replaces nothing, and releases the candidate like any other end without success.

## Managed edits and Actions

```text
ordered edit operations
  -> transaction-local EditWorkingState
  -> update object, link-edge, and link-slot overrides
  -> validate effective objects, endpoints, and cardinality
  -> diff final working state against commit-start state
  -> plan and finalize one commit
```

`EditWorkingState` is not durable. Its original snapshots remain pinned to the commit start, while
its mutable overrides let operation N+1 observe operation N. In `continue` mode, a rejected
operation rolls back only its working override; provider and infrastructure failures abort the
whole transaction.

Action-backed edits carry the run's terminal record. The commit validates the trusted Action
execution and the record's `executionId`, then inserts the record in its own transaction before new
work, so edits never land without the run that made them and a run id commits once: a second insert
for it fails the commit. An exact replay returns the stored commit and inserts nothing; the carried
record is not part of the commit's intent. The edits' semantic result lives only in the ontology
commit, correlated by Action origin; the Action run is not a second commit ledger.

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
- `storage/ontology/`: durable ontology commit, source, replacement plan, materialization, and
  outbox contracts.

Keep use-case entrypoints explicit. Share mechanics only after they have identical semantics; do
not hide projection candidate lifecycle, edit continuation, or telemetry batching behind a generic
workflow engine.

## Vector profiles

The SDK's explicit `index()` captures an internal `PreparedObjectVector`: object/profile identity,
configuration and source fingerprints, canonical input text, object revision and current vector
commit id. Source values stay local to preparation rather than being copied into the write payload.
Text is ordered JSON pairs of source names and values; missing/null values become `null`, while
empty strings remain distinct. The configuration includes an encoding version.

The configured model runs outside the transaction. Atomic edits then verify the object revision,
source/configuration fingerprints and vector commit id before storing validated float32 values.
An unrelated edit may conservatively reject in-flight indexing even when an existing vector remains
valid. A provider failure leaves the current representation untouched and is never retried here.
Effective-state changes invalidate affected profiles in the same transaction as the object write.
