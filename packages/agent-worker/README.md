# @sixb/agent-worker

Runs `agent.run.requested` queue jobs for a Sixb project.

The worker claims queued agent intents created by `sixb.agents.request(...)`, reserves or reclaims
the run record, keeps the run lease alive while the model is streaming, writes the final assistant
message, and finalizes the run.

## Usage

```ts
import { AgentWorker } from "@sixb/agent-worker"

const worker = new AgentWorker(sixb, {
  apiBaseUrl: "http://localhost:3002",
  tools,
})

await worker.start()
```

`sixb` must provide `storage.agents`, `storage.auth`, `queues.agents`, `agents`, `broker`, and
`sandboxes`.

## Execution Model

- User requests persist the user message and enqueue an intent.
- The worker reserves the run at claim time, so queued intents do not create orphan run records.
- The run lease is the authority for ownership; heartbeat renewal keeps it fresh during the turn.
- Lease-fenced finalization prevents stale workers from writing after a reclaim.
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
- Lease lost mid-turn: no writes from the stale worker
- Finalization storage failure: job is retried up to a bounded attempt limit; if finalization still
  cannot be recorded, the job is marked failed and the run remains non-terminal for repair

## Options

- `tools`: additional AI SDK tools exposed to the model alongside the built-in `bash` tool.
- `apiBaseUrl`: required Sixb server origin that hosts the agent API gateway. The worker injects a
  run-scoped gateway URL into sandboxes as `SIXB_API_BASE_URL`, writes Agent Skills into
  `SIXB_SKILLS_DIR`, and creates the sandbox with a restricted network policy allowing the server
  origin. The gateway authorizes scoped ontology, object, telemetry read, and action routes from the
  run lease and managed agent service account; no bearer token is exposed to the sandbox.
- `concurrency`: maximum number of agent run jobs this worker claims and executes at once; defaults
  to `4`.
- `streamSink`: stream sink override; defaults to a broker-backed sink.
- `leaseMs`: run lease and queue visibility duration; defaults to 60 seconds.
- `heartbeatMs`: lease renewal interval; defaults to one third of `leaseMs`.
- `turnTimeoutMs`: wall-clock turn budget; defaults to 5 minutes.
- `defaultMaxSteps`: model step cap when an agent does not specify one; defaults to `8`.
- `idlePollMs`: queue polling interval while idle.
