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
group or command help remains available when exact arguments are unknown. `actions request --wait`
returns the terminal run in the same command when it finishes within 25 seconds.

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

Requests run under the agent's [execution identity](../../../docs/models/tools-and-authorization.md), so the agent can only see
and act on what its groups allow — the same checks as any other caller, and only while the run is
active.

The upload route keeps its normal simple-file ceiling and gets a route-specific gateway body limit;
other gateway requests remain capped at 1 MB. Staged and direct-provider uploads are not exposed.
Agents must preview and ask for confirmation before starting a domain-changing action or workflow.
Workflow agent nodes cannot start another workflow, which bounds recursive execution. Generic
object/link writes, telemetry append, workflow cancellation/interventions/node diagnostics, and
infrastructure or administration routes remain outside the gateway.

Workflow run detail includes the run's top-level output after success. Agent gateway responses omit
the route's internal node records, and only top-level input/output file paths are available.

## Usage persistence

- **Usage and cost are saved atomically.** Storage recovery deduplicates replays.
- **Unknown is never zero.** Invalid estimates preserve valid usage and reported charges. Accepted
  streams interrupted before final usage retain unknown meters/cost and any native IDs received.

Use `storage.aiCosts.listModelCalls()` to read immutable call-time costs and optional estimates.
Provider request, response, and generation IDs appear in the model-call API and Atlas when supplied;
internal fallback response IDs are separate.

This is a call-level ledger: requests that fail before returning a stream and process crashes before
recording are outside its guarantee.

## How agents use a sandbox

You rarely call `runCommand` yourself. The agent worker does it:

1. When a run starts, the worker calls `factory.create(...)` with a **restricted** network policy
   whose only allowed origin is the sixb API gateway. The agent can reach the gateway and nothing
   else.
2. Sandbox boot overlaps the model's first response — it is provisioned concurrently and each
   sandbox tool awaits it lazily on first use, so boot latency does not block the turn.
3. Each `read` call runs a fixed, bounded script with model input passed as command arguments. Each
   `bash` call becomes `runCommand("bash", ["-lc", script], ...)`.
4. On run teardown the worker calls `destroy()`.

Because egress is locked to the gateway, the agent's only way to read or write app data is through
that gateway — there is no open internet. See
[Agent tools and the gateway](../../../docs/models/tools-and-authorization.md) for what the gateway exposes.

## Child agents

Delegation is temporarily disabled: the Agent does not receive `spawn_agent` or `wait_agent`.
The child runtime is retained for later re-enablement.

When enabled, the Agent can delegate focused tasks to headless child agents and choose any language
model configured in `models.language`, continue working after a child starts, and wait only when it
needs the result. Children are created at runtime; no extra
project configuration is required.

Each child:

- inherits and independently revalidates the parent's durable authority;
- receives all project tools plus an isolated sandbox and scoped Sixb API access;
- owns a durable run, usage records, stream, and isolated sandbox, but no conversation thread;
- is cancelled if its parent finishes while it is still active.

Up to four children may be active per parent run. They execute on a separate worker lane so waiting
parents cannot consume their capacity. Child agents cannot delegate again or start workflows in
this first version.

When several models are configured, the Agent sees the default, capabilities, and context limits
declared by their providers when available. Prices and runtime speed are not guessed;
the default remains the fallback when there is no clear reason to select another model.

## Child runs

Delegation tools are temporarily unavailable to the conversational Agent. The retained child-run
protocol is described below for existing runs and future re-enablement.

Child events are recorded in the broker, but V1 does not expose their streams through the client
API. The parent receives their durable results through `wait_agent`.

Child file references remain part of that result's JSON: they are not automatically mounted in
the parent's sandbox or published as conversation attachments. Accessing child files and choosing
which deliverables to show the user are separate concerns.
