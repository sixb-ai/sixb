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
public domain SDK. `ontology.indexVectors` authorizes only the persisted results of its work item or durable group.
The Materializer checks membership, identity, values and each object/vector revision in the transaction. Execution provenance
references the source ontology commit; requester and groups are empty, so only project budgets apply.

The durable `running` fence precedes admission, so superseded work cannot reserve budget. The
provider starts only after both succeed. An admission rejection returns work to pending for retry.
Redelivered `running` work has an uncertain provider outcome: fail visibly through `onError`, never
silently repeat inference. The provider may have billed a lost response. Failures remain inspectable until superseded or explicitly indexed.

Persist `ready` values before committing. On unrelated edits, reprepare the object revision and reuse
those values. Source changes, deletion/recreation, or configuration mismatch discard obsolete work.
A vector-only commit never schedules itself. Manual indexing remains available through authorized
SDK executions; its valid result also makes queued work unnecessary.

Projection replacement assigns `batchId` within each materialization page: same object type,
profile, configuration and source commit, at most 32 members / 32 KiB of serialized source text.
Membership is stored alongside intent in the activation transaction; there is no fill timer, process
buffer or cross-run aggregation. An oversized text is isolated, never truncated.

Dispatch uses the group id. Processing reads current members, drops obsolete work, and splits them
to the adapter's optional `EmbeddingModel.batching` count / UTF-8 byte bounds. Unknown bounds or
oversized inputs use individual calls. Search, explicit indexing and managed edits stay individual.
Each actual provider request produces one usage/cost record, under the project's group execution.
Admission claims all prepared members atomically before reserving budget; a superseded member
aborts that claim. Results become ready atomically for surviving members, then publish together in
one materialization transaction. PostgreSQL groups vector writes and intent cleanup in SQL; SQLite
reuses prepared statements within that transaction. Every object and vector retains its own revision
fence. A conflict rolls back publication and reprepares the current subset without inference. After
three conflicts, individual publication lets stable peers finish while contended members are deferred.
Restarted ready members only retry storage; running members fail with an unknown outcome.
A partly processed group publishes ready members together and resumes other members individually.

Network calls never hold storage transactions. Applications without projections do not start this
indexing consumer. Byte bounds are conservative transport eligibility, not the accounting layer's
token estimate; they do not reject or truncate a text that can still be sent individually.

Terminal failures persist a canonical `SixbFailure` before `onError`: `vector.model_unavailable`,
`vector.response_invalid`, or `vector.outcome_unknown` for interrupted calls. Unclassified failures
use `internal.unexpected`. These codes never authorize automatic inference retries. Accounting uses
`ModelExecutionSession`; its existing recovery consumer can replay accounting without inference.
