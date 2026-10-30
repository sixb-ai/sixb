# Run sessions

A run's session is the one way its runner reads and writes shared state for it. The agent worker
opens one per claimed run and calls nothing else on a run's path. A runner outside the worker will
reach the same operations over HTTP, so none of them may assume they share a process with storage.

```text
run-session.ts             AgentRunSession: conversation turns and child agents
run-session-children.ts    a turn's children and mail
run-events.ts              the stream sink a session publishes live records through
workflow-node-session.ts   WorkflowAgentNodeSession: workflow agent steps
```

## Claiming

`claimAgentRun` starts a queued run, or reclaims one whose last delivery's lease lapsed, with a
fresh execution token. `openAgentRunSession` opens the session of a run already claimed. A step's
`claimWorkflowAgentNode` does both for its agent node.

## Fencing

Every durable write carries the session's token, and storage refuses it once another delivery
reclaimed the run: finishing, the context checkpoint, workspace transitions, spawning a child and
clearing a child's dead attempt. `assertOwned` checks the same before a side effect storage cannot
fence, such as a sandbox action.

## Operations

```text
renewLease · cancelled · assertOwned   ownership, and a cancel of the run or of its parent
modelCalls()                           admission, usage and recovery; opened on first use, inside
                                       the runner's preparation retry
events · heldCalls                     live records (best effort) and the approvals that hold a run
conversation · people · execution()    what a run reads to prepare; createCheckpoint is its write
children · mail                        a turn's children, their threads, and mail between them
workspace                              a persistent workspace's acquire, replace and settle
finish                                 messages and the run's end in one transaction, then the
                                       host's afterFinish: stopping children, resuming a decided turn
```

## Outside the session

The worker's loops stay its own: dispatching queued runs, repairing approvals, recovering model-call
records and finishing runs that never started. `publish_artifact` still writes artifact versions
itself, through the worker context's `artifactPublishing`, until artifacts publish through the API.
Project tools run with the run's execution-bound `sixb`, which reaches storage only through the
run's authority.
