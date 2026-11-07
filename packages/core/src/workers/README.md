# Workers

`Worker` supervises a loop, `QueueWorker` claims and settles queue jobs, and `RunWorker` adds what a
durable run needs on top: surviving the process that runs it. This file describes that last part.

## Run recovery

A queue delivers jobs at least once, and a run has to come out the same however many deliveries it
takes. So a job is only a reason to look at a run, and the run decides what happens. Every delivery
starts with one claim, in the transaction that holds the run (`planRunClaim`):

| Run | Claim | Delivery |
| --- | --- | --- |
| `queued` | `started` | Starts it, under a new execution token |
| `running`, nothing holds it | `resumed` | Takes it up under a new token, one attempt further |
| `running`, held | `held` | Is a duplicate: comes back when the hold ends |
| `queued`, and a sibling must end first | `waiting` | Waits for the sibling's end to wake the run |
| anything else | `settled` | Has nothing to do: completes |

Three things make that safe:

- **The token.** Every write to a run or its steps carries the token of the execution making it, and
  the store refuses a stale one. A worker that was only slow cannot write over the one that took its
  run.
- **The lease.** A run's `execution` copies the queue lease of the delivery holding it, renewed with
  it (`projectRunLease`). The queue stays the only source of timing. A duplicate can tell a live
  holder from a dead one, so a second job never fences out a healthy run.
- **The hand-back.** A worker that stops, or an attempt that fails, expires its lease
  (`releaseExecution`), so the job that comes back does not wait one out that nobody holds. If that
  write is lost, the lease runs out by itself. A worker stopped by a deploy hands the attempt back
  too; an attempt that failed stays spent.

A run that loses its worker stays `running`. `cancelled` is not what a stopped worker writes: an
abort signal means the delivery ended, and says nothing about the run. A cancel is a decision
recorded on the run, by anyone and without a token, and the execution holding it finds out at its
next fenced write.

Attempts are counted on the run, never from how often its job came round, so waiting spends nothing.
The delivery past the fifth attempt still gets the run: it records what already happened, a commit
that landed above all, starts nothing new, and ends the run `failed` with the steps or nodes it left
running. It announces its `*.run.finished` like any other: schedules and the Console read that outcome.

### What each primitive supplies

`RunWorker` is the mechanism for syncs, pipelines, workflows and projections: claim, lease, hand-back,
attempts.

| Primitive | Worker | Resume point | Lives in |
| --- | --- | --- | --- |
| Sync | `RunWorker` | Its one commit: recorded if it landed, otherwise read again from the last checkpoint | `packages/sync-worker/src/run-sync-job.ts` |
| Pipeline | `RunWorker` | The steps not on record as succeeded, found by step id | `packages/pipeline-worker/src/run-pipeline-job.ts`, `run-step.ts` |
| Workflow | `RunWorker` | The first node not on record as finished | `recoverRunning`, `packages/workflow-worker` |
| Projection | `RunWorker` | Adopts its candidate; telemetry from its checkpoint | `startOrReclaim`, `packages/projection-worker` |
| Agent | `QueueWorker` | None: ends `cancelled` with `finishReason: "interrupted"`, since a replay would repeat tools and bill the turn again | `endInterruptedAgentRun` |
| Webhook | None | Runs the handler again on the provider's retry, once its own lease lapsed | `canRetryWebhookRun`, `packages/core/src/webhooks/delivery-lease.ts` |
| Action | None | None: runs inline, and writes its record once, when it ends | |

What stays specific, and why:

- **Workflows** wake from `waiting` through `resume`, not through a claim: a resume job first checks
  what woke the run (`claimRun`), and a run's `attempt` starts over at each resume, so a workflow
  with ten human steps is not ten attempts in.
- **Projections** run on `RunWorker`, but the job takes the run, under the token `RunWorker` made:
  the materializer fences its commits with that token, a claim also asserts the run's immutable
  identity, and a replay answers from the run's outcome. A run that fails transiently retries without
  a cap, because each attempt keeps its candidate and its progress, so a hand-back spends nothing. A
  queued projection run is republished through its dispatcher, which knows whether its revision still
  applies (`republishQueuedProjectionRuns`).
- **Agents** share `RunOwnedElsewhereError`, and end a lost run instead of claiming it. Their repair
  loop stays in the agent worker: a lost run ends, children and held approvals with it, so it holds
  no lane's shape, and republishing queued runs alone would save the `runs` pass nothing.
- **Webhooks** have no queue, so the API process renews a lease of its own while the handler runs:
  60 s, every 15 s, the numbers of a dataset flush. It survives three lost renewals, so a database
  blip does not run a live handler twice, and it ends well before most providers retry. A retry
  during the lease gets `503` with `Retry-After`, never `202`: the handler may still fail, and a
  provider stops retrying once it hears "accepted". A provider that never retries loses a delivery
  the process died on, as it always did. A run an older API started has no lease and is judged from
  when it started.

### A lake commit and its record

A commit and the record of it are not one transaction. A run writes its rows into a session no reader
sees, so before the commit there is nothing to undo, and after it the version exists whatever happens
to the run. Whoever takes over asks the lake: `findProducedVersion` looks up the version by
`producer.runId` (and `stepId`), the way an ingest flush finds its batch.

The version must still be there. Retention keeps every version back to the earliest commit a live
run or a flush in flight may have left unrecorded (`LakeRetention.keepVersionsForMs`), or a resumed run
would miss its own commit, and write it twice.

A commit can also land and answer with an error: a connection lost during `COMMIT`, or a query after
it. So any error once a run has reached its commit goes through the same lookup before anything calls
the run failed, and if the lake cannot say, the run stays open for the next delivery to ask.

- A **sync** first stores what the commit will have read (`prepareCommit`). Otherwise a crash right
  after the commit would keep the rows and lose the checkpoint they advance, and the next run would
  read them again. Being a fenced write, this is also what stops a stale execution from committing.
  A sync that never prepared a commit has none to look for, however busy its dataset is.
- A plain write then commits against the version it read just before that (`guardLatestVersion`), and
  an execution that slept past its fence is refused. A merge already commits against its base, or
  rebases on source sequences. This guard, and not one run per sync, is what stops a stale process:
  a rule about runs says nothing about a process that already passed it, or about a run an older
  version left. A resumed run looks for its commit once more after taking the guard, so a commit it
  misses lands after the guard. If another writer wins that race, nothing was written, and the run
  goes round again.
- A **pipeline step** does the same with the guard it always had. A step that loses it to the commit
  it was redoing records that commit instead of failing. Steps are found on record by step id, so a
  deploy that moves a step does not run it again; a step the deploy removed ends `cancelled`.

### One run of a sync at a time

A checkpoint is one cursor, and two runs reading from it read the same rows. So a queued sync run
waits while another run of that sync is `running`, however that one is doing, and triggers that
arrive meanwhile join it, through one job per run. The check holds in the transaction that claims the
run (an advisory lock on PostgreSQL). Datasets stay multi-writer, which is why this is a rule about
syncs and not about the dataset: guarding every sync from its start would fail it for any ingest that
landed while it read.

A run that ends wakes the oldest run waiting for it, with a job of its own. The waiting job comes back
once a minute in case that word gets lost, and the `runs` pass brings a job to a sibling whose lease
lapsed. Only a sibling with an execution counts: an older version's run never promised this rule, so
it holds nothing back, as on that version.

### Runs of an older version

A running run with no lease was started by a version that recorded none. A worker of that version may
still hold it during a rolling deploy, and nothing can tell. For `ORPHANED_RUN_AFTER_MS` (24 h from
its start) such a run counts as held: new workers leave it alone, and its old worker finishes it
without a token. After that a delivery finds it settled, and only `republishLostRuns` ends it:
`cancelled`, with an error saying the worker was lost, so the trigger rule fires again.

Rows an older version left can be months old, since nothing swept them. Any run lost for a week ends
the same way instead of going on, so a queued workflow does not fire its side effects by surprise.
`sixb check` counts both what will go on and what will end before the orchestrator starts. A lost job
cannot be told from a stopped queue, so a week is past any outage we mean to survive, and a queue
stopped for longer has its runs end. A job still in such a queue can reach its run first.

### Jobs that never come back

A delivery can only recover a run it reaches. `republishLostRuns` is the orchestrator's `runs` pass,
every 30 seconds on its maintenance loop. It brings a job to syncs, pipelines and workflows that have
none: queued runs whose job was lost, and running runs whose lease lapsed, which covers one handed
back. Projections join it, queued and lapsed. A job on its way gets 30 seconds first, so a clean
shutdown publishes nothing beside the job that came back.

It asks each store for those runs alone (`listLost`), from the `(project_id, status, ...)` index:
queued and running rows are few however long the history, so a project with nothing lost reads no
row, and live runs cannot use up its limit. Running runs come first, because queued ones may only be
waiting for a sibling. Being wrong about a job being lost costs a delivery that
finds the run held or finished.

### Limits

- Two executions asleep at once: if an attempt's commit lands after a later attempt prepared its own,
  the run records the later attempt's checkpoint with the earlier attempt's rows. It takes two
  processes paused for longer than a lease, each at its last moment.
- An old worker running for longer than `ORPHANED_RUN_AFTER_MS` after its version was replaced has its
  run cancelled under it.
- Events are not transactional with anything here: a step that finished before a crash does not
  announce its version again.
- A commit that fails its reply while still landing, and becomes visible only after the lookup, reads
  as not landed. The lake answers `COMMIT` once it is durable, so this takes a lake that replies
  before its own commit is readable.

`runRunRecoveryContractSuite` in `packages/core/src/testing` holds every primitive to this: a crash, a
clean shutdown, a duplicate delivery, and a stale execution. `packages/cli/tests/run-recovery.e2e.ts`
kills real workers at each commit boundary, and `run-recovery-infra.e2e.ts` does it on BullMQ,
PostgreSQL and a DuckLake PostgreSQL catalog, with a real lease running out.
