# Run sessions

A run's session is the one way its runner reads and writes shared state for it. The agent worker
opens one per claimed run and calls nothing else on a run's path. A runner outside the worker will
reach the same operations over HTTP, so none of them may assume they share a process with storage.

```text
run-session.ts             AgentRunSession: conversation turns and child agents
run-session-children.ts    a turn's children and mail
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
so a run ends without a queue job coming back for it.

A cancel is recorded on the run (`requestAgentRunCancel`) before the broker carries it. The run
token stops working at once, and a runner that never hears the broker reads the cancel at its next
lease renewal, which aborts the session's `cancelled`.

## Fencing

Every durable write carries the session's token, and storage refuses it once another delivery
reclaimed the run: finishing, the context checkpoint, workspace transitions, spawning a child and
clearing a child's dead attempt. `assertOwned` checks the same before a side effect storage cannot
fence, such as a sandbox action, and mail checks it before it sends.

Whichever write finds the run gone throws `AgentExecutionLostError` (`run-fence.ts`), never a
storage error, so a runner checks for one error. Mail is sent as the session's run, which names
its sender, and only to its own children's threads or to the turn that spawned it.

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
modelCalls()                           admission, usage and recovery; opened on first use, inside
                                       the runner's preparation retry
events · heldCalls                     live records (best effort) and the approvals that hold a run
plan() · memory                        what a run is set up with, as plain data (run-plan.ts): its
                                       model, SIXB.md, skills, tool names, the requester's ontology
                                       docs and a turn's delegation models; and the memory it reads
context() · checkpoint                 what a run starts from, in one read (run-turn.ts), and the
                                       compaction write, which answers the history that follows
threads · children · mail              the conversation's messages, a turn's children, and mail
                                       between them; reads answer only for the run's conversation
artifacts                              the conversation's artifacts, read as the requester, and
                                       what the run publishes into it (run-artifacts.ts)
files                                  where the run's files are stored and read: its attachments,
                                       its tools' and children's files, its artifacts' files
authorization · workspace              for a runner that binds the project in its own process: the
                                       execution's authority, and a persistent workspace's moves
finish                                 messages and the run's end in one transaction, then the
                                       host's afterFinish: stopping children, resuming a decided turn
```

`tests/agent-run-session-contract.ts` is what every session does: the in-process one runs it now,
and a session over HTTP runs the same suite.

## Outside the session

The worker's loops stay its own: dispatching queued runs, repairing approvals, recovering model-call
records and finishing runs that never started. Project tools run with the run's execution-bound
`sixb`, which reaches storage only through the run's authority.
