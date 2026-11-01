# Runtime design

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## Runners

A turn runs the same way whichever runner runs it: `runConversationTurn`
(`src/run-conversation-turn.ts`) prepares it from its session, runs it, and records how it ended.
The runner keeps what is its own, as a `ConversationTurnRunner`:

```text
the worker               a queue delivery holds the run; preparation retries a blip in place; a
                         thread's workspace comes from the project's sandbox factory and recipe
a runner over HTTP       its own lease renewals hold the run; its sandbox is its own; its session
                         is createHttpAgentRunSession
```

Children run in their turn's runner, on the turn's mailbox (see [child runs](#child-runs)).

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

Inside the sandbox, the `sixb` CLI calls the live project API with the run's token, so the agent
works against current project data instead of a snapshot. The provider adds the token outside the
guest (Vercel's firewall, a forwarder on the host or in a VM guest) and commands reach the API at
the sandbox's credentialed address, so no command holds it. The token opens a restricted slice of
the API (everything else returns `403`):

| Area | Routes |
| --- | --- |
| Project | `GET /api/project` |
| Object types | `GET /api/object-types`, `GET /api/object-types/:id` |
| Objects | `GET /api/objects`, `POST /api/objects/query` (+ `/links`, `/count`, `/exists`, `/facets`), `GET /api/objects/:objectTypeId/:objectId` |
| Telemetry | `POST /api/telemetry/history`, `GET .../telemetry/:propertyId/history`, `.../latest` |
| Actions | `GET /api/actions`, `GET /api/actions/:actionId`, `POST /api/actions/:actionId`, `GET /api/action-runs`, `GET /api/action-runs/:runId` |
| Workflows | `GET /api/workflows`, `GET /api/workflows/:workflowId`, `POST .../:workflowId/runs`, `GET /api/workflow-runs`, `GET /api/workflow-runs/:runId` |
| Files | `POST /api/files`, object/action/workflow-run/message `GET .../files/content` routes |
| Datasets | `GET /api/datasets`, `GET /api/datasets/:datasetId` (+ `/versions`, `/rows`) |
| Syncs and pipelines | `GET /api/syncs`, `GET /api/syncs/:syncId`, `GET /api/sync-runs`, `GET /api/pipelines`, `GET /api/pipelines/:pipelineId`, `GET /api/pipeline-runs`, `GET /api/pipeline-runs/:runId` |

Requests run inside the run's own [execution](../../../docs/models/tools-and-authorization.md), like its project tools:
what they start is part of the run, keeps the run's requester, and counts toward its usage. The
agent can only see and act on what its groups allow — the same checks as any other caller; a
workflow task keeps its groups when auth is disabled. Access is checked when a request is admitted,
so only while the run is active; a request admitted before the run ends still finishes in it.

Requests keep the API's own body limits. Staged and direct-provider uploads are not exposed.
Agents must preview and ask for confirmation before starting a domain-changing action or workflow.
Workflow agent nodes cannot start another workflow, which bounds recursive execution. Generic
object/link writes, telemetry append, workflow cancellation/interventions/node diagnostics,
starting a sync or pipeline, and infrastructure or administration routes stay closed to run tokens.

Project tools run where the project is, never in the sandbox or the harness: a turn's and a child's
through their session's `callTool`, a workflow task's in the worker (`runAgentTool` in core either
way). Their `sixb` is the run's execution-bound SDK, with the authority a run-token request
resolves; its type shows only object reads, actions, models and connectors. The model supplies only
ids, and the SDK checks every read and request against the run's authority: the user's access for a
conversation, the task's groups for a workflow task. Their model calls bill to the run, admitted and
recorded with its own. The files a tool puts are stored where it runs and copied into the sandbox by
the harness, at their path in its context directory, before the model reads the tool's output.
Their `attachments` open a manifest key only in a message of the run's own thread, like the
message file route, or among a workflow task's input files.

Workflow run detail includes the run's top-level output after success. Responses to a run token omit
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

## Replaying history

A turn rebuilds its request from stored messages, and the provider's prompt cache reads only the
longest prefix identical to an earlier request. So what turn N+1 sends for turn N must be the bytes
turn N's last request sent, on every storage:

- **JSON prints with sorted keys** (`models/protocols`), live and on replay: Postgres `jsonb` hands
  stored objects back in its own key order. Tool outputs, synthesized call arguments and Anthropic
  `tool_use` inputs; opaque provider items replay as stored, since the provider parses them.
- **A projected tool output replays as the model read it.** When a tool's `toModelOutput` differs
  from its output (`view_file`, `publish_artifact`, `wait_agent`, project tools returning files), the
  tool-call part keeps it as `modelOutput`, and `toModelMessages` sends it verbatim. The HTTP API
  leaves it out. Its files are materialized again where that output named them: `tool-files/` of
  the call that stored one, `children/<key>/` for `wait_agent`, or the path a file it showed already
  had. The 50-file window and the sandbox budget bound what is materialized, never what is replayed;
  a user's files take the budget first.
- **Runtime input is derived again.** The `<sixb_tool_files>` message after a step's results is
  rebuilt from the stored trace by the same functions (`replayToolFiles`).
- **An output too large for the context is saved to a file** ([tool-outputs.ts](../src/tools/tool-outputs.ts)).
  Past `TOOL_OUTPUT_FILE_MIN_BYTES`, the model reads a preview, the call's `modelOutput`, and the
  whole output is in `tool-outputs/<call id>.txt` of the context directory. The file is derived from
  the stored output alone, so each run writes its history's files again, newest first within a
  budget: a blank sandbox, or a computer's, starts without them. `read` and `view_file` page by
  themselves and are never saved; a sandbox that cannot take the file leaves the output whole.
- **Attachments stay inline until compaction**, each user message with its own text budget.
- **A request inlines at most 16 MiB of images, 100 of them** (`AGENT_INLINE_IMAGE_LIMITS`),
  spent in thread order, oldest first: attachments, then the images after each step, then the
  run's own steps (`allocateInlineImages`). The first image that does not fit closes the budget:
  nothing after it is projected, and projections run a few at a time, decided in order. An image
  that fitted stays inline; one past the budget reads as metadata from its own turn on, until
  compaction frees the budget. Estimates count each inline image as `AGENT_IMAGE_INPUT_TOKENS`.

## Compacting a conversation

A turn's preflight (`context-compaction.ts`) compacts once the estimate crosses the model's limit,
its window less the output reserve (see `context-budget.ts`):

- **It aims at 60 % of the limit**: the system prompt and tools, the summary at its longest, and
  the recent turns that fit the rest stay; the next turns grow into the room left. A context that
  does not fit even compacted fails the turn as `agent.context_limit_exceeded`, which the app and
  the TUI show without a retry.
- **An idle thread compacts below the limit** when its last model call is older than the cache its
  calls ask for (`modelCacheLifetimeMs`: an hour for a conversation) and it weighs at least
  `AGENT_IDLE_COMPACTION_TOKENS`, when compacting brings it under that size
  (`shouldCompactIdleContext`): the next call rewrites the cache anyway. Its summary is sent without
  caching, as the next request starts from the summary. One whose compaction fails goes on as it
  is.
- **The summary continues the cached request.** The environment builds it as the turn would
  (`BuildConversationRequest`): the previous turn's request, with the same system prompt, tools,
  reasoning and cache intent, then one `<sixb_summary_request>` message. Changing thinking, effort
  or tools would make the provider read the conversation again at full price; `summaryReasoning`
  is where to change that choice. Its output allows the summary plus the reasoning.
- **It is rewritten, not chained**: the earlier summary is part of what the model reads, and the
  instruction states the length. A summary the output limit cut short, or past its allowance, keeps
  its complete lines and says so; an empty answer leaves the user's messages instead. Nothing the
  summary writes fails the thread.
- **A history too long to read at once** is summarized in steps, oldest first, each from the summary
  so far; a turn too large alone is read with its longest texts and results cut.
- The whole conversation stays stored: `sixb history` reads it in the sandbox, through the run's
  own thread only.

## How agents use a sandbox

You rarely call `runCommand` yourself. The agent worker does it, and every run kind goes through
one lifecycle, `RunSandbox` in [run-sandbox.ts](../src/run-sandbox.ts), with one of two behaviors:

- **Ephemeral** ([ephemeral-run-sandbox.ts](../../agent-worker/src/ephemeral-run-sandbox.ts)): created for one
  run and destroyed when the run releases it. It is blank for an unbound conversation, a subagent
  on a provider without `resume`, or a workflow node; a workflow step's own `sandbox` factory makes
  it a workspace from its static recipe, destroyed after its credentials are revoked.
- **Persistent** ([persistent-run-sandbox.ts](../../agent-worker/src/persistent-run-sandbox.ts)): a thread's
  workspace, resumed by each run and saved by `beforeFinalize` before the run's terminal write: a
  bound conversation's, and on a provider with `resume` a subagent's, blank (see
  [paused children](#paused-children)). Run teardown never destroys it; only a subagent that ended
  does, through `beforeFinalize({ discard: true })`.

A `RunSandbox` also names the run's **context directory** (`$SIXB_CONTEXT_DIR`), where the run's
files go: skills, ontology docs, memory, attachments, artifacts, tool files, saved tool outputs,
children's files and the agent's `sixb`. Both behaviors keep it at `.sixb/agent` in the working directory, which a
checkout excludes from Git. Every path the worker writes, checks or names in the prompt comes from
it, as the agent names it: relative to the working directory, or absolute.

For a blank sandbox:

1. When a run starts, the worker calls `factory.create(...)` with a **restricted** network policy
   whose only allowed origin is the Sixb API. The agent can reach the API, with its run token,
   and nothing else.
2. Sandbox boot overlaps the model's first response — it is provisioned concurrently and each
   sandbox tool awaits it lazily on first use, so boot latency does not block the turn.
3. Each `read` call runs a fixed, bounded script with model input passed as command arguments. Each
   `bash` call becomes `runCommand("bash", ["-lc", script], ...)`.
4. On run teardown the worker releases it, which calls `destroy()`.

A cancellation or a worker shutdown cancels a workflow node's `create()`. Finishing the node never
does: a sandbox still booting then is destroyed once it is ready.

A workspace, a thread's or a step's, is ready before the first model call instead, so the system
prompt can describe the checkout, and its network follows its recipe, which always includes the
Sixb API. For a step's workspace:

- A step whose sandbox fails to provision after model preparation fails the node; it is not
  retried, because the clone and setup may have run.
- A worker crash leaves a step's ephemeral sandbox running until the provider's own timeout, as it
  does for a blank sandbox.

Because a blank sandbox's egress is locked to the Sixb API, its agent's only way to read or write
app data is the API, with its run token — there is no open internet. See
[Agent tools](../../../docs/models/tools-and-authorization.md) for what the run token opens.

## Child agents

The Agent can delegate focused tasks to headless child agents with `spawn_agent`, on a tier or any
language model configured in `models.language`, keep working after a child starts, and collect
results with `wait_agent` only when it needs them. Children are created at runtime; no extra
project configuration is required. The conversation rules say when to delegate: independent,
heavier investigations that can run in parallel, never a lookup or a second opinion.

Each child:

- inherits and independently revalidates the parent's durable authority, and its approval mode;
- receives all project tools plus an isolated, blank sandbox, kept while it pauses on a provider
  that resumes sandboxes, and scoped Sixb API access;
- knows the project as its parent does: `SIXB.md`, the skills, the ontology index, the requester's
  time zone and locale, and the memory, which it reads and the API refuses to let it save;
- gets the conversation prompt's data rules, never its rules for talking to the user;
- publishes artifacts into its conversation (`conversationThreadId`) as its own run, so a retry of
  the parent removes them with the parent's own;
- gets the files its parent passed in `spawn_agent`'s `files`, at their paths in the parent's
  sandbox, listed in its task and in `$SIXB_ATTACHMENTS`, and returns what it writes to `out/`;
- works in a thread of its own, its run's `threadId`, beside a durable run, usage records and
  stream (see [Child threads](#child-threads));
- stops with its parent: when the parent finishes or is cancelled, or its runner stops. Once its
  parent has ended, the API and the publish transaction refuse it. A child waiting on its
  question when its parent finishes pauses instead: see [questions to the parent](#questions-to-the-parent);
- is never replayed: one its runner stopped with, or left running, ends `interrupted`, since it may
  already have run actions or published. Its parent decides whether to spawn it again;
- holds a call its mode does not run on its parent's turn, and pauses: see
  [paused children](#paused-children).

`subagentConcurrencyPerRun` children may be active per parent run, 4 by default. They run in the
parent's runner (see [Child runs](#child-runs)), up to `subagentConcurrency` at once across its
turns, 4 by default; one over that waits queued for a slot. Parents hold no child slot, so a waiting
parent never starves a child. Child agents cannot delegate again or start workflows.

The delegation guide lists each model from its configured definition, never its provider catalog,
so it stays the same from turn to turn and catalog I/O cannot fail a turn. Prices and runtime speed
are not guessed.

## Paused children

A child's held call is filed on its parent turn (`runId` the turn, `callerRunId` the child). The
approval records decide, never the prompt or the tool output (`src/run-subagent.ts`,
`src/subagent-continuation.ts`):

- **The child pauses.** Its loop stops after the step that made the call (`pauseAfterStep` on
  `holdsRun` for the child), or at its finish when a command left running held one. It ends
  `succeeded` with `finishReason: "awaiting_approval"`, maybe without an answer, with what it did
  as its thread's next message and its `out/` in its result. `wait_agent` treats it as done:
  `status: "awaiting_approval"`, its waiting calls, and no files, which would pass for complete.
- **The turn never stops a child for a held call.** Its own call pauses it after the step that
  made it. A child's pauses it only once none of its children is queued or running
  (`turnPausesOnHeldCalls`), so it goes on waiting for the others. A turn that pauses, after a
  step or because it ended holding a call, first waits for its children still at work: its end
  cancels them, and one that holds a call pauses by itself meanwhile. The wait wakes on their finishes: see
  [the parent's waits](#the-parents-waits).
- **The resumed turn continues it.** The report that resumes a turn marks each outcome whose caller
  paused on its calls `caller.continues`, and the model reads that from the part. Before the
  model runs, `continuePausedChildren` admits each such child, still paused, as the next run of its
  thread under this turn and the same key (`createSubagentRunId(turn, key)`, so a replay finds it,
  with `thread.create: false`). Its trigger holds the outcomes, copied without their caller so the
  child reads them as its own, what came back to its new sandbox (its `out/`, or why none could be
  kept) unless its workspace is kept, and when it continues. The model, task and handed files are the paused child's; the mode
  is this turn's. A new message continues none.
- **A retried resume continues it again.** The retry keeps its trigger, so it continues the child
  again under its own id. The runs of the thread after the pause that ran under the failed
  attempt are waited for until they stop (`clearDeadAttempts`; a lapsed lease ends one at the latest),
  then their messages leave the thread (`deleteByRunId`), as a retried turn's leave its own.
- **Its history is its thread.** A continuation reads its thread's messages: the task and handed
  files, dated by the thread's creation, each run's work and each trigger, in order, so its request
  starts like the paused run's last one. A call whose tool projected its output replays the stored
  `modelOutput`, what the model read, and the files those calls returned are materialized again at
  the paths that output named (`prepareAgentAttachments` over the thread's messages), with the
  images that followed their step (`replayToolFiles`), as a turn replays its history.
  At its finish everything under `out/` returns, the inherited files included.
- **Its workspace is kept on a provider that resumes.** The child's thread holds its own
  `sandbox_state` (a random name), through the conversation's state machine: the fence is the
  thread's active run, whatever its kind. Its first run creates it while the model starts, as a
  blank ephemeral sandbox boots. A pausing run saves it (`stop()`, settled `ready`); the
  continuation resumes it by name, before its first model call, and finds every file as it left
  them. The handed files are listed again but not copied, except those under `.sixb/agent`, which
  every opening and save of a workspace removes. A run that ends without pausing (answered, failed
  or stopped) destroys it before its terminal write and settles `unavailable`: its files are
  mid-work, never a point the thread goes on from. A paused child that never continues
  (superseded, expired, stopped or replaced) keeps its stopped sandbox until the provider's
  retention removes it: the sandbox contract has no destroy by name.
- **Otherwise it starts blank again**, with the handed files and the paused run's `out/`
  (`result.files`), which a pausing child stores in either case: without `resume`; once `resume`
  reports the state lost (`replace`); or when the run before left the state anything but `ready`
  (a snapshot that failed at a pause, which still pauses and destroys the VM; a destroyed workspace
  that a retried turn or an answer after a dead attempt continues; a crash that left it `busy`).
  In that last case the acquire starts a fresh state under a new name
  (`startSubagentWorkspaceAgain`), where a conversation would need an explicit recreation, which
  nobody can do on a child's thread. Either way `resetAt` reaches the system prompt.
- **The parent waits by the old id.** `wait_agent` resolves the run id of a child of an earlier turn
  of the conversation to its thread's latest run, the one of this turn that continues it when there
  is one, and answers with the id it was given. `spawn_agent` refuses a key a continuation holds:
  its run works in a thread an earlier turn spawned.
- A decision made while the turn still runs takes effect once it pauses: it then resumes at once,
  and the child continues in the next turn.

## Messages to a child

The parent steers a child still at work with `message_agent({ key, text })`. The key, not a run
id, names the child, so it stays right across a continuation (`src/subagent-tools.ts`,
`src/subagent-inbox.ts`, `src/family-mailbox.ts`):

- **Transport.** A turn and the children it runs share a runner, so what they say to each other
  never leaves it: the turn's mailbox (`FamilyMailbox`), one per turn, held in memory. Its id,
  `<parentRunId>:<modelCallId>:<toolCallId>`, names the call: a replay sends nothing twice, and a
  provider that reuses tool call ids across steps still sends two messages. There is no table:
  both threads keep it, the parent's tool call and the child's `mail` part.
- **Kinds.** A `message` steers the child; `answer` and `deferred` are replies to its question
  (see [questions to the parent](#questions-to-the-parent)), never read as messages.
- **Reading.** At each step boundary the child takes what came since its last read, so a message
  sent while it was queued is read at its first step. The messages become one user message of
  `mail` parts, projected as `<sixb_parent_message id="…">`, the sender's text escaped, which
  stays in the history of every later step.
- **As it answers.** When the model answers without tools and a step is left, `beforeComplete`
  reads the inbox once more. A message there adds a step after the answer, marked `afterAnswer`:
  the child is told its parent has not received that answer, and writes its result again. Its
  answer is what it wrote after; `wait_agent` also returns the one before as `earlierAnswer`, so
  an addendum never replaces the answer it amends, or says in `answerNote` that the child did not
  answer again.
- **In the child's thread.** Each delivery is a user message of the run that read it, between the
  steps it came between, written with the run's finish, so a continuation replays it in place,
  with the bytes the child read.
- **Pausing.** A child whose call is filed (`holdsRun`) or that paused is refused: it reads nothing
  until a later turn continues it. As it pauses, on a held call or on its question, it stops
  reading, and what came that it never read is kept on its run (`result.unread`): the run that
  continues it, under a later turn and perhaps another runner, reads it first, in its trigger.
  Mail sent after it stopped reading is refused, saying it paused or ended. Until it continues,
  `wait_agent` lists the unread in `unread`.
- **Refusals.** A key that is no child of the turn, a child of one of the conversation's 20 latest
  earlier turns (spawn it again), a child that ended, and a paused one are refused, each with what
  to do.

## Questions to the parent

A child asks with `ask_parent({ question })` and waits for the answer within its step. The
question and its replies go through the turn's mailbox, as messages do (`src/subagent-inbox.ts`,
`src/family-mailbox.ts`, `src/subagent-tools.ts`):

- **Asking.** The child puts its question, id `<childRunId>:<modelCallId>:<toolCallId>`, in the
  turn's mailbox and waits for the reply to it (`inReplyTo` the question), bounded by its signal:
  its cancel, or its parent's. One question at a time: a second `ask_parent` while one waits is
  refused. Replies never reach the step-boundary reads as messages, and the first reply counts.
- **The parent's wait wakes.** A question wakes the parent's waits at once (see
  [the parent's waits](#the-parents-waits)). `wait_agent` returns as soon as a question comes, from any child
  of the turn, not only those it waits for, since a child blocked on its question never finishes.
  A question it already returned no longer stops a wait for other children, only a wait for its
  own. `questions` (`key`, `runId`, `id`, `text`) lists the questions it returns first and those
  of the children it waits for, and each is on its child's result.
- **Answering.** While the child waits on a question the model has read, the parent's next
  `message_agent` to its key is the answer: an `answer` mail, which `ask_parent` returns as
  `{ answer }`. The question is claimed before the mail is written, so of two answers sent at once
  the second is a message. A message sent before the model read the question stays a message. The
  answer's id is the call's, so a replay is the same answer, sent once.
- **A question the model has not read.** When the model answers without tools, a question it has
  not read comes as one more step, a `<sixb_child_questions>` block: the turn does not end on an
  answer that ignores it.
- **The turn's end.** Before the turn records its end, while it still runs, it writes a `deferred`
  reply to each child still waiting on its question, and waits for each to pause: `succeeded`, `finishReason: "awaiting_answer"`, its work in its thread, the
  `ask_parent` call and its `deferred` output, which names the question's id, included, and its
  `out/` in its result. Only then does it wait for its other children when it pauses, and record its end, which
  cancels those still at work. The repair pass leaves a running turn's children alone, so a child
  that pauses is never cancelled under it. A cancelled turn or one that fails or times out stops
  its children, waiting or not, and their own signal ends the wait. A child that held a call in
  the same step pauses `awaiting_approval`: only a decision continues it, its `ask_parent` output
  then says it goes on without an answer, and it can ask again.
- **The next turn continues it.** A turn reads, after its conversation, a
  `<sixb_waiting_children>` block of the conversation's children still paused on a question. It
  comes from one indexed read, `runs.listThreadSubagents` with `finishReason: "awaiting_answer"`
  (a partial index on paused children), which finds none at once in a conversation that has none,
  however many turns it had. `wait_agent` lists a paused child's id as `awaiting_answer`, with its
  question, read from the last message of the run that paused. `message_agent` to a key no child
  of the turn holds reads the latest child under that key in the conversation, then the latest run
  of its thread, past the continuations that failed or were cancelled. One `awaiting_answer` is
  continued as the next run of its thread under this turn and the same key, as
  [paused children](#paused-children) are, with the answer's `mail` part in its trigger instead of
  outcomes; the failed attempts' messages leave the thread first, and a second answer in the same
  turn is refused. The continuation reads it, as a `<sixb_parent_answer>` block, after the thread's
  messages, so its request starts with the bytes the paused run's last one had. `wait_agent` by
  the old id returns its answer.

## The parent's waits

A turn waits for its children three ways: `wait_agent`; before its end, for each child it told
that its question waits to pause; and, when it pauses, for those still at work. Each wakes on
what it waits for (`src/subagent-tools.ts`, `src/family-mailbox.ts`):

- **The runner tells the turn.** When a child's run ends here, ended or paused, or its claim gives
  up, its runner tells the turn's mailbox, which wakes the turn's waits, as a question does. Each
  wake has the wait read the runs again, and only then: it is a wake, never a result. A wait takes
  the wake before it reads, so what comes during the read wakes it.
- **A re-check bounds an end recorded elsewhere.** A wait that nothing woke reads again after
  `CHILD_WAIT_RECHECK_MS` (5 s): a child still queued that the API cancels, or one a repair pass
  ends when its own end could not be recorded, ends outside the runner. A minute of waiting reads
  storage 12 times.

## Child runs

A child runs in its parent's runner: `spawn_agent` creates its queued run, and the coordinator
hands it to the runner's `startChild`, which claims it under the parent's delivery, its lease
renewed with the parent's, and runs it beside the turn. Nothing queues it, so a runner that stops
takes its children with it; a repair pass ends any run left running once its lease has lapsed. Nothing
redelivers a child either, so its runner retries a claim that storage refuses for as long as the
parent runs, and ends failed one it refuses for good: its parent's wait always returns.

Child events are recorded in the broker, and reach whoever reads the conversation: the API lists
its children, each its thread with the runs it took (`packages/core/src/agents/children.ts`, by
`threads.listChildren`), and `/ws/agents` streams a child's run as a turn's. The parent
receives their durable results through `wait_agent`: each child's final answer, the text it wrote
after its last local tool call, else its last text. `wait_agent` returns once every child it waits
for has ended, or one asks a question.

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
  by their path in `out/` and their `sandboxPath`, under `.sixb/agent/children/<key>/` (a key that
  is not a safe path segment gets a hash suffix), where `wait_agent` copies them, one at a time, and
  where later turns materialize them again, since the result's files reach `$SIXB_ATTACHMENTS` only
  then. Each file part names its child: its `logicalPath` is `<key>/<path>` and its `fileName` is
  unique, so later turns and the app pair them without their order. A child's files are in the first result that
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
