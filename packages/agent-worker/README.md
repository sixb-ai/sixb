# @sixb/agent-worker

Runs conversation, headless workflow-agent, and model-accounting recovery jobs for a Sixb project.

The worker claims durable conversation runs created by `sixb.agent.runs.request(...)` and agent workflow
nodes parked by the workflow worker. It starts or reclaims the execution, renews queue ownership,
records each completed provider call, and finalizes the conversation or workflow node.

## Usage

```ts
import { AgentWorker } from "@sixb/agent-worker"

const worker = new AgentWorker(sixb, {
  apiBaseUrl: "http://localhost:3001",
})

await worker.start()
```

For agent execution, `sixb` must provide `storage.agents`, `storage.aiUsage`, `storage.aiCosts`, `storage.auth`,
`queues.agents`, `definitions.models` (or workflow agent steps), `broker`, and `sandboxes`.

Embedding-only projects can start `new AgentWorker(sixb, {})` for accounting recovery without a
sandbox or API origin. See [recovery-only operation](./docs/usage-accounting.md#recovery-only-operation).

## Execution Model

- User requests atomically persist the user message and a `queued` run before dispatch.
- The queued run is the dispatch intent, without a parallel outbox table. Requests publish it
  immediately; when that publication fails, the worker republishes it with the same deterministic
  queue job id on its next repair pass (at start, then every 30 seconds).
- A workflow agent step's job is acknowledged only after its workflow resume is queued. A
  redelivery that finds the step already succeeded only queues the resume.
- The worker transitions the durable run from `queued` to `running` when it claims the job.
- Before each conversation turn, the worker estimates the next model request and checkpoints older
  complete turns when it crosses the model's input budget. Context limits come from the model
  definition, or its provider-backed `resolve()` when the selected execution is prepared. Worker
  startup does not resolve catalog models. The prepared snapshot is shared by compaction and
  generation. If no context limit is available, the worker uses a 128,000-token fallback and warns
  during preparation.
  Catalog transport/access failures use an offline snapshot; invalid definitions and model identity
  mismatches fail preparation of the selected execution.
  Separate input limits are respected; input-only metadata is treated as a conservative window
  with the same output reserve. The reserve is the least output every call keeps: 16,384 tokens or a
  quarter of the window, or more for a reasoning token budget. A call's ceiling is what its estimated
  input leaves of the window, never below the reserve and never above the cap: the binding's
  `maxOutputTokens`, else the model maximum, else the reserve. A call with an attached file gets
  the reserve, since files have no byte-to-token rate.
- The queue lease is the sole authority for liveness and redelivery; the worker renews it during
  turns.
- Every completed provider call from Sixb's owned model loop is appended to `storage.aiUsage` with
  an immutable valuation in `storage.aiCosts`; API conversation and workflow-agent summaries are
  derived from that ledger. A conversation turn's usage and cost cover everything below its
  execution, its children and what its tools ran, as Activity counts it: a workflow a tool started
  counts even for what it spends after the turn ends. A child that knows fewer counts, cut short
  mid-call, leaves the others' and makes the turn's usage `partial`. Accepted interrupted streams
  are recorded with unknown final usage and cost, retaining received native IDs. Run rows do not store a second usage aggregate.
- Every delivery rotates a durable execution token that fences stale finalization after redelivery.
  Usage remains unfenced because a completed provider call is billable even when execution ownership
  changes afterward. The run also persists the queue-returned lease expiration for gateway
  authorization. That value is a projection of the queue lease—not a separate run lease, timer, or
  heartbeat—and is extended only from successful queue renewals.
- The assistant message append and successful run finish happen in one storage transaction.
- Conversations get `spawn_agent`, `wait_agent` and `message_agent`. `spawn_agent` takes a tier or one of the exact
  `{ provider, modelId }` pairs of the project catalog, for example
  `{ provider: "vercel-ai-gateway", modelId: "deepseek/deepseek-v4-flash-vision-exp" }`. Its guide
  lists each model from its configured definition: name, description, context limits and
  capabilities, never a price, which is not known. The schema restricts selection to configured
  pairs, the worker rechecks them before creating a child, and omitting `model` uses the default.
  Each child works in a thread of its own, which holds its task and then its work.
  `wait_agent` returns each child's final answer, the text it wrote after its last local tool call
  (else its last text). A child whose call waits for approval pauses, its work in its thread, and comes
  back `awaiting_approval`; the turn pauses once no other child is at work, and the turn that
  resumes it continues the child first (see
  [paused children](./docs/runtime-design.md#paused-children)). `spawn_agent`'s `files` copy
  paths of the parent's sandbox into the child's; what a child that succeeds writes to `out/` comes
  back as files of `wait_agent`'s result, under `.sixb/agent/children/<key>/` for the turn and in
  `$SIXB_ATTACHMENTS` after, by their `logicalPath` `<key>/<path>`, and what it published is
  installed in the parent's `$SIXB_ARTIFACTS` (see
  [runtime design](./docs/runtime-design.md#child-runs)). It returns a minute before
  the turn's deadline (`WAIT_ANSWER_MARGIN_MS`), with the children still at work as `running`.
  `message_agent` writes to a queued or running child's inbox, by its key; the child reads it
  before its next step, and `wait_agent` lists in `unread` what a child ended without reading
  (see [messages to a child](./docs/runtime-design.md#messages-to-a-child)).
- Project context comes from the host definitions that `createSixb()` discovered and validated,
  never from the worker's filesystem: conversations and their children receive `SIXB.md` as their
  instructions and every skill in `definitions.agent.skills`; a workflow agent step receives only
  the skills it selects.
- Every agent run renders one ontology reference doc per object type its execution can see, from
  its authorized view, flagging marked properties it is not cleared for, and installs them with the
  project's other `ontology/` docs and scripts under `SIXB_ONTOLOGY_DIR`. Runs with the same view
  (visible types, restricted properties, requestable actions) share one rendering. A
  conversation's and a child's prompt list the files, as a tree; past 150 files the tree shows
  folders with file counts. A workflow step's own instructions can point to them.
- Reasoning supports `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  and `max`. The chat picker uses the configured model's catalog-supported levels. Sixb's native
  providers validate and translate the requested effort without silently lowering it.

## Usage accounting

Every completed conversation, compaction-summary, and workflow-agent provider call is appended to `storage.aiUsage`,
including individual calls in tool loops and calls completed before later cancellation, tool
failure, output validation, or execution ownership loss. Workflow nodes use their own durable
execution and inherit the parent workflow's admission-time group snapshot. Usage writes are
intentionally not fenced: a stale worker cannot finalize the execution, but a provider call it
completed remains billable.

The model loop awaits accounting before it can make another billable call. The worker retries the
idempotent, atomic usage-and-cost transaction and hands any persistent infrastructure failure to a
durable job in `queues.agents`. Recovery uses bounded backoff and cannot trigger another provider
call. If the durable handoff also fails, the owning agent run or workflow fails closed rather than
silently losing usage. This local path cannot close a process-crash window before a completed stream
is observed; provider-side reconciliation is the appropriate later layer for that guarantee.

Recovery also accepts queued jobs from older workers that captured only a pricing context. Their
usage is recorded idempotently without assigning a historical cost from current model prices.

Valuation is captured at call completion. Provider-reported totals are authoritative when present;
otherwise the core model runtime rates exact token meters against the model's immutable rate card.
Missing rate cards or incomplete cache/token meters remain explicitly unpriceable. Routed provider
and model identities are stored separately from the gateway identity. Catalog discovery is never on
the inference or accounting path.

## Attachments and artifacts

A file a tool returns, from a project tool or `view_file`, stays in that tool's result and shows in
the work trace. What the user receives is what the Agent publishes.

Earlier files in the retained conversation are discoverable through the sandbox's
`$SIXB_ATTACHMENTS` manifest and inspectable using `view_file` when materialized. Current user
attachments and file-producing tool results retain their model-input projections.

`publish_artifact` creates an artifact and `publish_artifact_version` publishes the next version of
one (`src/artifacts/publish-tool.ts`). They are two tools so that every argument of each is required:
a mode carried by an optional or null argument is where models differ, and with every property
required each model adapter sends both schemas strict. Offered only to conversations whose storage
holds artifacts, each reads a file or directory from the sandbox, stores its bytes against the run's
file budget, which counts identical content once, and publishes it with the thread and run as its
origin, authored by whoever asked for the turn: a new artifact for the thread's owner, or the next
version of one the requester owns or this conversation already shares, so a turn never shares
someone else's artifact in another conversation. The turn installs, revises and refers to
artifacts through the requester's own `sixb.artifacts`, so it reaches nothing they could not.
Validation runs first; the version commits in a transaction that checks the run still holds its
execution token and asks core's access rule again, so a run reclaimed by another delivery, or a
requester removed meanwhile, publishes nothing. The version exists when the tool returns: the
conversation shows it mid-turn, a cancelled run keeps it, and retrying the run deletes it with the
run's messages. After a deck publishes, the
layout check (`src/artifacts/layout-check/`) lays it out in the sandbox's Chromium, serving only
the files the version holds; it bounds every wait on the page and exits before its command's
timeout, so a deck that hangs costs a partial report rather than a browser left running.

Before each conversation run, `src/artifacts/materialize.ts` installs the latest version of each
artifact the thread published under `$SIXB_ARTIFACTS_DIR/<id>/` and lists them in `$SIXB_ARTIFACTS`,
newest first within a byte budget; an artifact whose files cannot be read is listed without them.
Each publish replaces its artifact's copy and entry, so both stay the latest version during the run.
The built-in `sixb-artifacts` skill (`src/skills/`) describes the formats the publisher accepts; its
examples are published in the tests.

## Memory

Before each conversation run, `src/conversation-memory.ts` reads the requester's `user` repo and
the `project` repo, which every conversation builds up, through `sixb.agent.memory`, so the
requester's own access decides what is installed, and installs their latest files under
`$SIXB_MEMORY_DIR/<repo>/`, with a starter `MEMORY.md` while a repo has none.
`context/memory.json` records the revision and each file's SHA-256 as installed; `sixb memory
save` (`src/agent-cli/commands/memory.ts`) sends the files that differ from it through the gateway,
which records the run's thread as the save's source. `src/agent-runtime/memory.ts` holds that
layout for both sides. A requester with no repo of its own, such as a service account, gets the
project's alone.

The `<sixb_memory>` section closes the system prompt with when and how to save, then each repo's
`MEMORY.md` as it was at the thread's start, or at its latest checkpoint once compacted, so a save
mid-thread leaves the prompt, and the prompt cache, unchanged; the installed files are always the
latest. Its examples are each one command that edits `MEMORY.md` and saves it: given the edit and
the save as two steps, small models stop after the edit or save without one. Organizing topic files
and merging a conflict is the `sixb-memory` skill (`src/skills/sixb-memory/`): it is installed with
the memory and named by the section rather than listed in the skill catalog, so runs without memory
keep their prompt as it was. Compaction estimates the section like the rest of the prompt, and the
continuation after a checkpoint shows the memory as of that checkpoint.

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

Live model UI chunks are broker records only. They are not inserted into `agent_messages`.
`agent_messages` stores the finalized assistant message after the model turn completes or is
interrupted with coherent partial progress, including completed tool steps when cancellation happens
while preparing the next model request.

The default sink is created with `createBrokerStreamSink(...)`. Tests can pass `NOOP_STREAM_SINK` or
a custom `streamSink`.

## Run Fate

The terminal run state is stored on the run record:

- Model or tool failure: `failed`
- Sandbox provisioning failure during a conversation or workflow agent node: `failed`, even if the
  model never invokes a sandbox tool; in-flight inference is aborted with the original failure reported
- Turn timeout: `failed` with `finishReason: "timeout"`; coherent partial work is finalized as the
  assistant message before the thread is released. This controlled limit is not emitted as an
  unhandled runtime failure. A child times out at its parent's deadline, its wait in the queue
  included
- User cancel during a turn: `cancelled`
- Step limit reached before an answer: `succeeded` with `finishReason: "tool-calls"` and a
  `step_limit_reached` diagnostic
- Model output limit reached: a conversation turn is `succeeded` with `finishReason: "length"` and
  an `output_limit_reached` diagnostic. It keeps what the model produced; tool calls the model was
  still writing are dropped, never executed. A workflow agent node or subagent fails instead with
  `agent.execution_failed`, naming the cause, so a cut-short answer is never passed on as complete
- Worker shutdown during a conversation turn: `cancelled` with `finishReason: "interrupted"`,
  coherent partial work kept as the assistant message so the user can continue from it
- Queue ownership lost mid-turn: the turn is aborted and stale durable writes are fenced
- Conversation turn or child found `running` on redelivery (its worker crashed or lost the queue
  lease): `cancelled` with `finishReason: "interrupted"`, recorded without calling the model. It
  already billed its model calls and may have run actions or published, so a turn is retried only
  on request (`POST .../runs/:runId/retry`) and a child only if its parent spawns it again.
  Workflow agent nodes are replayed instead. A run whose projected queue lease has not lapsed is
  still owned by a live delivery: a duplicate job leaves it alone and is retried once that lease
  runs out
- Preparation dependency failure (storage, model catalog) before the first model call: retried in
  place with a short backoff, never through a redelivery
- Finalization storage failure: job is retried up to a bounded attempt limit; if finalization still
  cannot be recorded, the job is marked failed and the run remains non-terminal for repair

## Options

- `apiBaseUrl`: required for agent execution; Sixb server origin that hosts the agent API gateway. The worker injects a
  run-scoped gateway URL into sandboxes as `SIXB_API_BASE_URL`, installs the self-documenting `sixb`
  CLI on `PATH`, writes the run's project skills into `SIXB_SKILLS_DIR` and ontology docs into
  `SIXB_ONTOLOGY_DIR`, and creates the sandbox
  with a restricted network policy allowing the server origin. The gateway authorizes scoped
  ontology, object, telemetry, file publication, action, and workflow routes from the run execution
  token and restored execution authority; no bearer token is exposed to the sandbox.
- `concurrency`: maximum number of agent run jobs this worker claims and executes at once; defaults
  to `8`.
- `subagentConcurrency`: maximum number of child agents this worker executes at once, on a lane of
  their own so waiting parents cannot consume their capacity; defaults to `4`.
- `subagentConcurrencyPerRun`: maximum number of child agents one conversation turn keeps queued or
  running at once, across workers; defaults to `4`.
- `streamSink`: stream sink override; defaults to a broker-backed sink.
- `leaseMs`: queue visibility duration; defaults to 60 seconds. The worker renews it while the turn
  runs.
- `turnTimeoutMs`: wall-clock turn budget; defaults to 10 minutes.
- `defaultMaxSteps`: framework model step cap; defaults to `100`.
