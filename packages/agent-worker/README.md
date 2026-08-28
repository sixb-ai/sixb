# @sixb/agent-worker

Runs conversation and headless workflow-agent queue jobs for a Sixb project.

The worker claims durable conversation runs created by `sixb.agents.request(...)` and agent workflow
nodes parked by the workflow worker. It starts or reclaims the execution, renews queue ownership,
records each completed provider call, and finalizes the conversation or workflow node.

## Usage

```ts
import { AgentWorker } from "@sixb/agent-worker"

const worker = new AgentWorker(sixb, {
  apiBaseUrl: "http://localhost:3002",
})

await worker.start()
```

`sixb` must provide `storage.agents`, `storage.aiUsage`, `storage.aiCosts`, `storage.auth`,
`queues.agents`, `agents`, `broker`, and `sandboxes`.

## Execution Model

- User requests atomically persist the user message and a `queued` run before dispatch.
- The queued run is the dispatch intent; workers republish it with a deterministic queue job id until
  it is claimed, without a parallel outbox table.
- The worker transitions the durable run from `queued` to `running` when it claims the job.
- Before each conversation turn, the worker estimates the next model request and checkpoints older
  complete turns when it crosses the model's input budget. Context limits come from the pinned
  Models.dev snapshot, with a 128,000-token fallback when an exact provider/model is unavailable.
  Agent `loop.context` values are optional overrides; omitting them keeps compaction enabled.
- The queue lease is the sole authority for liveness and redelivery; the worker renews it during
  turns.
- Every completed `streamText` and `generateText` provider call is appended to `storage.aiUsage`
  with an immutable Models.dev valuation in `storage.aiCosts`; API conversation and workflow-agent
  summaries are derived from that ledger. Run rows do not store a second usage aggregate.
- Every delivery rotates a durable execution token that fences stale finalization after redelivery.
  Usage remains unfenced because a completed provider call is billable even when execution ownership
  changes afterward. The run also persists the queue-returned lease expiration for gateway
  authorization. That value is a projection of the queue lease—not a separate run lease, timer, or
  heartbeat—and is extended only from successful queue renewals.
- The assistant message append and successful run finish happen in one storage transaction.

## Usage accounting

Every completed conversation and workflow-agent provider call observed by the AI SDK lifecycle is
appended to `storage.aiUsage` and rated against the same versioned Models.dev catalog the worker
uses for model context limits. The catalog is loaded when a worker has registered agents. This
includes individual calls in tool loops and calls completed before later cancellation, tool failure,
output validation, or execution ownership loss. Workflow nodes use their own durable execution and
inherit the parent workflow's admission-time group snapshot.
Usage writes are intentionally not fenced: a stale worker cannot finalize the execution, but a
provider call it completed remains billable.

The AI SDK swallows lifecycle callback errors, so the worker retries the idempotent append and hands
any persistent infrastructure failure to a durable job in `queues.agents`. Recovery retries with
bounded backoff and cannot trigger another provider call. Once an append is deferred, `prepareStep`
blocks the next model step and the owning Agent run or workflow fails closed while accounting
recovery continues independently. If the durable handoff also fails, the same stop prevents silent
usage loss. This local path cannot close a process-crash window before lifecycle delivery;
provider-side reconciliation is the appropriate later layer for that guarantee. A model middleware
also retains the provider's response model identity and provider metadata. Sixb rates only exact
Models.dev matches observed through reviewed AI SDK namespaces; custom providers, aliases, and
unsupported deployment contexts remain unpriceable rather than being normalized heuristically.

## Live Stream

Each run has a broker stream named `agents.runs.${runId}`.

The default `StreamSink` writes:

- `agent.run.started`
- `agent.compaction.started`
- `agent.compaction.completed`
- `agent.compaction.failed`
- `agent.ui.chunk`
- `agent.message.finalized`
- `agent.run.finished`

Live AI SDK UI chunks are broker records only. They are not inserted into `agent_messages`.
`agent_messages` stores the finalized assistant message after the model turn completes or is
interrupted with coherent partial progress.

The default sink is created with `createBrokerStreamSink(...)`. Tests can pass `NOOP_STREAM_SINK` or
a custom `streamSink`.

## Run Fate

The terminal run state is stored on the run record:

- Model or tool failure: `failed`
- Turn timeout: `failed` with `finishReason: "timeout"`; coherent partial work is finalized as the
  assistant message before the thread is released. This controlled limit is not emitted as an
  unhandled runtime failure
- Worker shutdown during a turn: `cancelled`
- Queue ownership lost mid-turn: the turn is aborted and stale durable writes are fenced
- Finalization storage failure: job is retried up to a bounded attempt limit; if finalization still
  cannot be recorded, the job is marked failed and the run remains non-terminal for repair

## Options

- `apiBaseUrl`: required Sixb server origin that hosts the agent API gateway. The worker injects a
  run-scoped gateway URL into sandboxes as `SIXB_API_BASE_URL`, installs the self-documenting `sixb`
  CLI on `PATH`, writes configured project skills into `SIXB_SKILLS_DIR`, and creates the sandbox
  with a restricted network policy allowing the server origin. The gateway authorizes scoped
  ontology, object, telemetry, file publication, action, and workflow routes from the run execution
  token and managed agent service account; no bearer token is exposed to the sandbox.
- `skillsDir`: optional project Agent Skills directory. Defaults to `<projectRoot>/skills`. Set to
  `false` to disable project skills.
- `concurrency`: maximum number of agent run jobs this worker claims and executes at once; defaults
  to `4`.
- `streamSink`: stream sink override; defaults to a broker-backed sink.
- `leaseMs`: queue visibility duration; defaults to 60 seconds. The worker renews it while the turn
  runs.
- `turnTimeoutMs`: wall-clock turn budget; defaults to 10 minutes.
- `defaultMaxSteps`: model step cap when an agent does not specify one; defaults to `25`.
- `idlePollMs`: queue polling interval while idle.
