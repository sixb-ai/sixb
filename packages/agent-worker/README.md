# @sixb/agent-worker

Runs `agent.run.requested` queue jobs for a Sixb project.

The worker claims durable queued runs created by `sixb.agents.request(...)`, starts or reclaims the
run record, renews queue ownership while the model is streaming, writes the final assistant message,
and finalizes the run.

## Usage

```ts
import { AgentWorker } from "@sixb/agent-worker"

const worker = new AgentWorker(sixb, {
  apiBaseUrl: "http://localhost:3002",
})

await worker.start()
```

`sixb` must provide `storage.agents`, `storage.auth`, `queues.agents`, `agents`, `broker`, and
`sandboxes`.

## Execution Model

- User requests atomically persist the user message and a `queued` run before dispatch.
- The queued run is the dispatch intent; workers republish it with a deterministic queue job id until
  it is claimed, without a parallel outbox table.
- The worker transitions the durable run from `queued` to `running` when it claims the job.
- The queue lease is the sole authority for liveness and redelivery; the worker renews it during
  turns.
- Every delivery rotates a durable execution token that fences stale finalization after redelivery.
  The run also persists the queue-returned lease expiration for gateway authorization. That value is
  a projection of the queue lease—not a separate run lease, timer, or heartbeat—and is extended only
  from successful queue renewals.
- The assistant message append and successful run finish happen in one storage transaction.

## Live Stream

Each run has a broker stream named `agents.runs.${runId}`.

The default `StreamSink` writes:

- `agent.run.started`
- `agent.ui.chunk`
- `agent.message.finalized`
- `agent.run.finished`

Live AI SDK UI chunks are broker records only. They are not inserted into `agent_messages`.
`agent_messages` stores the final assistant message after the model turn completes.

The default sink is created with `createBrokerStreamSink(...)`. Tests can pass `NOOP_STREAM_SINK` or
a custom `streamSink`.

## Run Fate

The terminal run state is stored on the run record:

- Model or tool failure: `failed`
- Turn timeout: `failed`
- Worker shutdown during a turn: `cancelled`
- Queue ownership lost mid-turn: the turn is aborted and stale durable writes are fenced
- Finalization storage failure: job is retried up to a bounded attempt limit; if finalization still
  cannot be recorded, the job is marked failed and the run remains non-terminal for repair

## Options

- `apiBaseUrl`: required Sixb server origin that hosts the agent API gateway. The worker injects a
  run-scoped gateway URL into sandboxes as `SIXB_API_BASE_URL`, writes Agent Skills into
  `SIXB_SKILLS_DIR`, and creates the sandbox with a restricted network policy allowing the server
  origin. The gateway authorizes scoped ontology, object, telemetry read, and action routes from the
  run execution token and managed agent service account; no bearer token is exposed to the sandbox.
- `skillsDir`: optional project Agent Skills directory. Defaults to `<projectRoot>/skills`. Set to
  `false` to install only the built-in Sixb skills.
- `concurrency`: maximum number of agent run jobs this worker claims and executes at once; defaults
  to `4`.
- `streamSink`: stream sink override; defaults to a broker-backed sink.
- `leaseMs`: queue visibility duration; defaults to 60 seconds. The worker renews it while the turn
  runs.
- `turnTimeoutMs`: wall-clock turn budget; defaults to 5 minutes.
- `defaultMaxSteps`: model step cap when an agent does not specify one; defaults to `25`.
- `idlePollMs`: queue polling interval while idle.
