# Run sessions

A run's session is the one way its runner reads and writes shared state for it. The agent worker
opens one per claimed run and calls nothing else on a run's path. A runner outside the worker will
reach the same operations over HTTP, so none of them may assume they share a process with storage.

```text
run-session.ts             AgentRunSession: conversation turns and child agents
run-session-children.ts    a turn's children
run-liveness.ts            ending a run whose lease lapsed
run-fence.ts               AgentExecutionLostError, and the writes that report it
run-turn.ts                what a turn or child starts from: AgentRunContext
run-events.ts              the stream sink a session publishes live records through
workflow-node-session.ts   WorkflowAgentNodeSession: workflow agent steps
```

## Claiming

`claimAgentRun` starts a queued run, or reclaims one whose last delivery's lease lapsed, with a
fresh execution token. `openAgentRunSession` opens the session of a run already claimed. A step's
`claimWorkflowAgentNode` does both for its agent node.

## Liveness

A run is held by whoever renews its lease. Once the lease recorded on it lapses, its run token
fails closed, and `endLapsedAgentRuns` (`run-liveness.ts`) may end it: it reclaims the run, which
rotates its token, then records it `cancelled` and `interrupted`. A worker's repair pass runs it,
and so does the API server every 30 seconds, for runners with no worker behind them: a run ends
without a queue job coming back for it.

What follows a turn's end, its children still at work stopped and a turn paused on calls already
decided resumed, is `afterAgentRunFinished` (`run-after-finish.ts`): the worker's session host and
the API's both run it.

A cancel is recorded on the run (`requestAgentRunCancel`) before the broker carries it. The run
token stops working at once, and a runner that never hears the broker reads the cancel at its next
lease renewal, which aborts the session's `cancelled`. That is the only signal a run hears from
outside its runner: a turn and its children share one, so their messages and questions, and a
child's end, stay in it (`FamilyMailbox` in `@sixb/agent`).

## Fencing

Every durable write carries the session's token, and storage refuses it once another delivery
reclaimed the run: finishing, the context checkpoint, workspace transitions, spawning a child and
clearing a child's dead attempt. `assertOwned` checks the same before a side effect storage cannot
fence, such as a sandbox action.

Whichever write finds the run gone throws `AgentExecutionLostError` (`run-fence.ts`), never a
storage error, so a runner checks for one error.

## Artifacts

A run's artifacts are its conversation's: a child's are its parent's. It reads them through its own
SDK, bound to its execution as its requester, the way the API binds a request with the run's token.
What it publishes is owned by the conversation's owner, authored by the requester, and names the
run and the conversation as its origin. `AgentRunArtifacts.publish` checks the run still holds its
execution, and a child's parent still runs, before it prepares the version and again in the
transaction that stores it. The session in a worker and `POST /api/artifacts` with a run token
both publish through it.

## Operations

```text
renewLease · cancelled · assertOwned   ownership, and a cancel of the run or of its parent
models.language(ref)                   the run's model, pinned once: each call is admitted against
                                       the requester's AI limits and records itself, so the runner
                                       never reports what a call used
callTool(call)                         one call of a project tool the run offers, for the runner
                                       that holds the run, run as the run (run-tools.ts): its input
                                       checked against the tool's schema, its model calls billed to
                                       the run and stopped with it, the files it puts stored within
                                       the run's budget and returned for the runner to copy in
events · heldCalls                     live records (best effort) and the approvals that hold a run
plan() · memory                        what a run is set up with, as plain data (run-plan.ts): its
                                       model, SIXB.md, skills, tool names, the requester's ontology
                                       docs and a turn's delegation models; and the memory it reads
context() · checkpoint                 what a run starts from, in one read (run-turn.ts), and the
                                       compaction write, which answers the history that follows
threads · children                     the conversation's messages and a turn's children; reads
                                       answer only for the run's conversation
artifacts                              the conversation's artifacts, read as the requester, and
                                       what the run publishes into it (run-artifacts.ts)
files                                  where the run's files are stored and read: its attachments,
                                       its tools' and children's files, its artifacts' files
authorization · workspace              for a runner that binds the project in its own process: the
                                       execution's authority, and a persistent workspace's moves
finish                                 messages and the run's end in one transaction, then the
                                       host's afterFinish: children stopped, a decided turn resumed
```

`tests/agent-run-session-contract.ts` is what every session does: the in-process one and the one
over HTTP run the same suite.

## Over HTTP

A runner outside the worker reaches the same session through the API (`run-session-http.ts`, served
by `run-session-serve.ts`). Each operation is one request to `/api/agent-runs/:runId/session/<name>`
with the run's token, and the server answers it with the in-process session's own code: what it
checks, fences and records is the same wherever the runner is.

```text
claim            POST /api/agent-runs/:runId/claim, as the person who asked for the turn
                 children.claim, with the turn's token, for a child of that turn
operations       JSON in, JSON out; dates, bytes and maps tagged (run-session-wire.ts)
models.stream    the provider's events, one JSON line each; the server admits and records the call
events           live records in batches, best effort
files.*          put, open and stat; a file's id is its content's digest
renewLease       answers whether the run, or the turn a child stops with, was cancelled: the only
                 signal a runner over HTTP hears, at most two minutes apart
```

Once a run ended, its token reaches nothing, so `finish` over HTTP also announces the end live: its
answer, then the run's end, from the server that recorded them.

The server pins a runner's messages to its run's thread and drops any author they name, and caps
the lease a runner asks for. `authorization()` is not offered: such a runner never binds the
project.

## Outside the session

The worker's loops stay its own: dispatching queued runs, repairing approvals, recovering model-call
records and finishing runs that never started. A workflow agent step runs only in the cloud, so the
worker runs its project tools itself, through the same `runAgentTool`.
