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
- publishes artifacts into its conversation (`conversationThreadId`) as its own run, so a retry of
  the parent removes them with the parent's own;
- gets the files its parent passed in `spawn_agent`'s `files`, at their paths in the parent's
  sandbox, listed in its task and in `$SIXB_ATTACHMENTS`, and returns what it writes to `out/`;
- works in a thread of its own, its run's `threadId`, beside a durable run, usage records and
  stream (see [Child threads](#child-threads));
- stops with its parent: when the parent finishes, is cancelled or times out. Its wall clock ends at
  the parent's deadline, which its spec carries, so its wait in the queue counts against it. Once
  its parent has ended, the gateway and the publish transaction refuse it;
- is never replayed: found `running` on redelivery, it ends `interrupted`, since it may already have
  run actions or published. Its parent decides whether to spawn it again;
- holds a call its mode does not run on its parent's turn, finishes and says so; `wait_agent` lists
  that call under `awaitingApproval`. The parent pauses on it only once the child has ended
  (`turnPausesOnHeldCalls`): pausing earlier would cancel the child. Children don't pause yet.

`subagentConcurrencyPerRun` children may be active per parent run, 4 by default. They execute on a
separate worker lane, sized by `subagentConcurrency`, so waiting parents cannot consume their
capacity. Child agents cannot delegate again or start workflows.

The delegation guide lists each model from its configured definition, never its provider catalog,
so it stays the same from turn to turn and catalog I/O cannot fail a turn. Prices and runtime speed
are not guessed.

## Child runs

Child events are recorded in the broker, but the client API does not expose their streams. The
parent receives their durable results through `wait_agent`: each child's final answer, the text it
wrote after its last local tool call, else its last text. `wait_agent` returns
`WAIT_ANSWER_MARGIN_MS` (a minute) before the parent's deadline, children still at work reported
`queued` or `running`, so the parent answers before it times out.

Files travel through blob storage, never through the model (`src/child-files.ts`):

- **To the child.** `spawn_agent` first checks each path without reading it: where it really leads,
  every symbolic link followed, must stay in the working directory and outside the run's own
  context under `.sixb/agent` (its API address among it), and the files must fit the attachment
  limits (50 files of 25 MB, 100 MB in all). Spawns of one turn are then admitted one at a time,
  and only that turn adds children to its run, so the parent's state, the active-child limit and a
  key used with other inputs are read before any file is: a refused spawn reads and stores none.
  The files are then read and stored one at a time, against the parent's run file budget, and
  their FileRefs go in the child's spec, so a replayed key with the same files is the same child.
  The child's environment writes them at the same relative paths, after its own artifacts, so a
  copy the parent edited keeps its changes; its project tools open them by that path.
- **Back to the parent.** A child that succeeds stores what it wrote to `out/` in its result, except
  a file it was handed there and left unchanged, against a budget of its own, apart from what it
  published. Past the same limits none comes back and the result's `filesError` says why and what
  to do; its answer still does. A child that fails, is cancelled, times out or is interrupted
  returns none, as it returns no answer.
- **In the parent.** `wait_agent` returns a rich tool result (`{ kind: "agentToolResult" }`): the
  children's results as JSON text, then each file as a file part. The JSON lists each child's files
  by their path in `out/` and their `sandboxPath` this turn, under `.sixb/agent/children/<key>/`
  (a key that is not a safe path segment gets a hash suffix), where `wait_agent` copies them, one
  at a time, since the result's files reach `$SIXB_ATTACHMENTS` only in later turns. Each file part
  names its child: its `logicalPath` is `<key>/<path>` and its `fileName` is unique, so later
  turns and the app pair them without their order. A child's files are in the first result that
  lists them, and a result holds at most the attachment limits of them, whole children only: one
  that does not fit, or whose files cannot be copied, says so in `filesNote` and comes with the
  next wait. It also installs the latest version of each artifact the waited children published a
  version of in the parent's `$SIXB_ARTIFACTS`, so the parent revises it as its own, and says in
  `artifactsError` when one could not be.

## Child threads

A child's thread is an `agent_threads` row with `kind = 'subagent'` and a `parent`: the
conversation, the turn that spawned it and its key. Its id is
`createSubagentThreadId(spawningRunId, key)`, which shares its first run's digest.

| Moment | What is written |
| --- | --- |
| `spawn_agent` | `runs.createSubagent`, in one transaction: the thread (owned by the conversation's owner), its task and the list of files handed to it as a user message with the run's id, and the queued run as the thread's active run. A replay with the same key writes nothing more |
| the child runs | its request is the thread's messages; the task closes with the thread's creation time, so each run of the child replays the same bytes. Memory is read as of the same time |
| the child finishes | its work as one assistant message, in the transaction of `runs.finish`, which releases the thread. A failed or stopped child keeps what it did, as an interrupted turn does |

Every message of a child's thread has a run id, its trigger too, so `deleteByRunId` removes a run's
messages whole. A later run of the thread (`thread.create: false`) is single-flight, as a turn is.

- **Read**: `createAgentThreadAccessRule` reads a child's thread exactly when it reads the
  conversation, with the same access. Observers read it by id.
- **Never listed**: `threads.list` returns conversations only, and the list indexes leave children
  out. A fork copies the conversation's messages, never its children.
- **No writes**: a message, a fork, participants, a thread mode or a sandbox recreation on a child's
  thread is refused with `thread_not_conversation` (409). A child's mode is its run's,
  copied from its turn: its thread reports that one to every reader (`approvalModeSource: "run"`).
- **Deletion**: its row goes with the conversation's (`ON DELETE CASCADE`).

The parent's own messages keep `spawn_agent` and `wait_agent`: they are the conversation's
condensed view of the child, and the only one a fork reader gets.
