# Runtime design

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## System prompts

The agent worker owns one system-prompt renderer for conversations, child agents, and workflow
tasks. It combines the baseline instructions (or a workflow step's `instructions`) with runtime
guidance and mode-specific rules for approval, output, and user communication.
Prompt composition is not worker configuration.

Runtime guidance includes the top-level CLI command catalog, so agents do not need to run `sixb
--help` to discover capabilities. Exact references retain a fast path: `objects get` before
relationship inspection, `actions get` before request, and JSON parameters through stdin. Narrow
group or command help remains available when exact arguments are unknown. `actions request` runs the
Action and returns its terminal run in the same command.

## Reaching your data

Inside the sandbox, the `sixb` CLI calls a run-scoped gateway that exposes a restricted slice of
the live project API. The worker configures that transport without exposing a bearer token, so the
agent works against current project data instead of a snapshot. These routes are available through
the CLI and gateway (everything else returns `403`):

| Area | Routes |
| --- | --- |
| Project | `GET /api/project` |
| Object types | `GET /api/object-types`, `GET /api/object-types/:id` |
| Objects | `GET /api/objects`, `POST /api/objects/query` (+ `/links`, `/count`, `/exists`, `/facets`), `GET /api/objects/:objectTypeId/:objectId` |
| Telemetry | `POST /api/telemetry/history`, `GET .../telemetry/:propertyId/history`, `.../latest` |
| Actions | `GET /api/actions`, `GET /api/actions/:actionId`, `POST /api/actions/:actionId`, `GET /api/action-runs`, `GET /api/action-runs/:runId` |
| Workflows | `GET /api/workflows`, `GET /api/workflows/:workflowId`, `POST .../:workflowId/runs`, `GET /api/workflow-runs`, `GET /api/workflow-runs/:runId` |
| Files | `POST /api/files`, object/action/workflow-run/message `GET .../files/content` routes |

Requests run inside the run's own [execution](../../../docs/models/tools-and-authorization.md), like its project tools:
what they start is part of the run, keeps the run's requester, and counts toward its usage. The
agent can only see and act on what its groups allow — the same checks as any other caller; a
workflow task keeps its groups when auth is disabled. Access is checked when a request is admitted,
so only while the run is active; a request admitted before the run ends still finishes in it.

The upload route keeps its normal simple-file ceiling and gets a route-specific gateway body limit;
other gateway requests remain capped at 1 MB. Staged and direct-provider uploads are not exposed.
Agents must preview and ask for confirmation before starting a domain-changing action or workflow.
Workflow agent nodes cannot start another workflow, which bounds recursive execution. Generic
object/link writes, telemetry append, workflow cancellation/interventions/node diagnostics, and
infrastructure or administration routes remain outside the gateway.

Project tools run in the worker, not the sandbox. Their `sixb` is the run's execution-bound SDK,
with the authority the gateway resolves; its type shows only object reads, actions, models and
connectors. The model supplies only ids, and the SDK checks every read and request against the
run's authority: the user's access for a conversation, the task's groups for a workflow task. Tool
authority is resolved once, at turn start, while the gateway re-resolves it on every request. Their
model calls use the run's accounting recorder; a gateway request gets its own, on the run's attempt.
Their `attachments` open a manifest key only in a message of the run's own thread, like the
gateway's message file route, or among a workflow task's input files.

Workflow run detail includes the run's top-level output after success. Agent gateway responses omit
the route's internal node records, and only top-level input/output file paths are available.

## Usage persistence

- **Usage and cost are saved atomically.** Storage recovery deduplicates replays.
- **Unknown is never zero.** Invalid estimates preserve valid usage and reported charges. Accepted
  streams interrupted before final usage retain unknown meters/cost and any native IDs received.

Use `storage.aiCosts.listModelCalls()` to read immutable call-time costs and optional estimates.
Provider request, response, and generation IDs appear in the model-call API and the app when supplied;
internal fallback response IDs are separate.

This is a call-level ledger: requests that fail before returning a stream and process crashes before
recording are outside its guarantee.

## How agents use a sandbox

You rarely call `runCommand` yourself. The agent worker does it, and every run kind goes through
one lifecycle, `RunSandbox` in [run-sandbox.ts](../src/run-sandbox.ts), with one of two behaviors:

- **Ephemeral** ([ephemeral-run-sandbox.ts](../src/ephemeral-run-sandbox.ts)): created for one
  run and destroyed when the run releases it. It is blank for an unbound conversation, a subagent
  or a workflow node; a workflow step's own `sandbox` factory makes it a workspace from its static
  recipe, destroyed after its credentials are revoked.
- **Persistent** ([persistent-run-sandbox.ts](../src/persistent-run-sandbox.ts)): a bound
  conversation's thread workspace, resumed by each run and saved by `beforeFinalize` before the
  run's terminal write. Run teardown never destroys it.

For a blank sandbox:

1. When a run starts, the worker calls `factory.create(...)` with a **restricted** network policy
   whose only allowed origin is the sixb API gateway. The agent can reach the gateway and nothing
   else.
2. Sandbox boot overlaps the model's first response — it is provisioned concurrently and each
   sandbox tool awaits it lazily on first use, so boot latency does not block the turn.
3. Each `read` call runs a fixed, bounded script with model input passed as command arguments. Each
   `bash` call becomes `runCommand("bash", ["-lc", script], ...)`.
4. On run teardown the worker releases it, which calls `destroy()`.

A workflow node's deadline also covers provisioning: it starts before the environment is created,
and it, a cancellation or a worker shutdown cancels `create()`. Finishing the node never does: a
sandbox still booting then is destroyed once it is ready.

A workspace, a thread's or a step's, is ready before the first model call instead, so the system
prompt can describe the checkout, and its network follows its recipe, which always includes the
gateway. For a step's workspace:

- A step whose sandbox fails to provision after model preparation fails the node; it is not
  retried, because the clone and setup may have run.
- A worker crash leaves a step's ephemeral sandbox running until the provider's own timeout, as it
  does for a blank sandbox.

Because a blank sandbox's egress is locked to the gateway, its agent's only way to read or write
app data is through that gateway — there is no open internet. See
[Agent tools and the gateway](../../../docs/models/tools-and-authorization.md) for what the gateway exposes.

## Child agents

The Agent can delegate focused tasks to headless child agents with `spawn_agent`, on a tier or any
language model configured in `models.language`, keep working after a child starts, and collect
results with `wait_agent` only when it needs them. Children are created at runtime; no extra
project configuration is required. The conversation rules say when to delegate: independent,
heavier investigations that can run in parallel, never a lookup or a second opinion.

Each child:

- inherits and independently revalidates the parent's durable authority, and its approval mode;
- receives all project tools plus an isolated, blank sandbox and scoped Sixb API access;
- knows the project as its parent does: `SIXB.md`, the skills, the ontology index, the requester's
  time zone and locale, and the memory, which it reads and the gateway refuses to let it save;
- gets the conversation prompt's data rules, never its rules for talking to the user;
- publishes artifacts into its parent's thread as its own run, so a retry of the parent removes
  them with the parent's own;
- owns a durable run, usage records and stream, but no conversation thread;
- stops with its parent: when the parent finishes, is cancelled or times out. Its wall clock ends at
  the parent's deadline, which its spec carries, so its wait in the queue counts against it.

Up to four children may be active per parent run. They execute on a separate worker lane, sized by
`subagentConcurrency`, so waiting parents cannot consume their capacity. Child agents cannot
delegate again or start workflows.

The delegation guide lists each model from its configured definition, never its provider catalog,
so it stays the same from turn to turn and catalog I/O cannot fail a turn. Prices and runtime speed
are not guessed.

## Child runs

Child events are recorded in the broker, but the client API does not expose their streams. The
parent receives their durable results through `wait_agent`: each child's final answer, the text of
its last step. A child's files stay in its sandbox, except the artifacts it publishes.
