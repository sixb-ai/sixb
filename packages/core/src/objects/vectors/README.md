# Vector indexing

A named profile identifies a derived representation, separate from object properties.

```text
Effective object change → invalidate stale vector + persist latest intent (one transaction)
ProjectionWorker → durable queue → project AI admission → provider → save result → fenced commit
```

`materializer/effective/vector-indexing.ts` compares effective source fingerprints after projection
conflict resolution, including managed overrides. New objects schedule every profile. Unrelated
changes schedule nothing. Deletion removes intent; each new generation replaces the old id.
There is no historical scan or configuration-only backfill.

The queue owns delivery leases. Ontology storage owns intent keyed by project/object/profile, plus
its generation id and `pending → running → ready` state. Dispatch has a separate due time so long
queues cannot starve later entries. Reconciliation can enqueue the same generation safely.

`indexing.ts` exposes only a core-owned processing capability. Kernel authority cannot bind the
public domain SDK. `ontology.indexVectors` authorizes one persisted result; the Materializer checks
its identity and values as well as object/vector revisions in the transaction. Execution provenance
references the source ontology commit; requester and groups are empty, so only project budgets apply.

The durable `running` fence precedes admission, so superseded work cannot reserve budget. The
provider starts only after both succeed. An admission rejection returns work to pending for retry.
Redelivered `running` work has an uncertain provider outcome: fail visibly through `onError`, never
silently repeat inference. The provider may have billed a lost response. Failures remain inspectable until superseded or explicitly indexed.

Persist `ready` values before committing. On unrelated edits, reprepare the object revision and reuse
those values. Source changes, deletion/recreation, or configuration mismatch discard obsolete work.
A vector-only commit never schedules itself. Manual indexing remains available through authorized
SDK executions; its valid result also makes queued work unnecessary.

V1 processes one object/profile per inference, with independently bounded concurrency. It coalesces
pending edits but does not batch different objects into one provider call. Network calls never hold
storage transactions. Applications without projections do not start this indexing consumer.

Terminal failures persist a canonical `SixbFailure` before `onError`: `vector.model_unavailable`,
`vector.response_invalid`, or `vector.outcome_unknown` for interrupted calls. Unclassified failures
use `internal.unexpected`. These codes never authorize automatic inference retries. Accounting uses
`ModelExecutionSession`; its existing recovery consumer can replay accounting without inference.
