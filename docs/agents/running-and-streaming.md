# Running and streaming

A defined agent does nothing until a conversation drives it. You drive it over HTTP — create a
thread, post a message, follow the run — and stream the run live over a websocket.

## Threads, runs, and messages

- A **thread** is one conversation with one agent, owned by a principal. It has a status (`active`
  or `archived`) and an ordered list of messages.
- A **run** is one turn. Posting a user message to a thread triggers a run.
- A **message** has a `role` (`system`, `user`, `assistant`) and structured `parts`: `text`,
  `reasoning`, `step-start`, and `tool-call`. The assistant message is persisted once the run finishes.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/agents` | List agents you can run. |
| `GET` | `/api/agents/:agentId` | Get one agent. |
| `GET` | `/api/agent-threads` | List threads (filter by `agentId`, `status`). |
| `POST` | `/api/agent-threads` | Create a thread (`{ agentId, title?, threadId? }`). |
| `GET` | `/api/agent-threads/:threadId` | Get a thread. |
| `GET` | `/api/agent-threads/:threadId/messages` | List a thread's messages. |
| `POST` | `/api/agent-threads/:threadId/messages` | Post a user message — **triggers a run**. |
| `GET` | `/api/agent-runs/:runId` | Get a run's status. |

## Trigger a run

There is no "run" endpoint — posting a message is the trigger. The `202` response returns the ids
you need to follow it:

```jsonc
// POST /api/agent-threads/:threadId/messages   { "text": "Which invoices are overdue?" }
{
  "threadId": "thr_...",
  "runId": "run_...",
  "triggerMessageId": "msg_...",
  "streamId": "agents.runs.run_...",
  "createdThread": false
}
```

The `runId` and `streamId` come back right away, so you can open the stream before the turn starts.
A thread runs **one turn at a time** — posting while a run is active returns `409`; wait for it to
finish first.

## Run status

`GET /api/agent-runs/:runId` returns the run record.

| Status | Meaning |
| --- | --- |
| `running` | The turn is in progress. |
| `succeeded` | The turn completed and the reply was persisted. |
| `failed` | A model/tool error or the turn timeout ended it (`error` has details). |
| `cancelled` | The run was aborted. |

A finished run also carries `finishReason` (`stop`, `length`, `tool-calls`, `content-filter`,
`error`, `other`, `unknown`), `usage` token counts (`inputTokens`, `outputTokens`, `totalTokens`,
`reasoningTokens`, `cachedInputTokens`), and `modelId`.

## Stream a run

Connect to `/ws/agents` and send JSON commands; the server replies with JSON events.

| Command | Fields | Purpose |
| --- | --- | --- |
| `subscribe` | `runId`, `threadId?`, `afterCursor?` | Follow a run live. |
| `replay` | `runId`, `threadId?`, `afterCursor?`, `limit?` | Read past records once. |
| `unsubscribe` | `runId?` | Stop the subscription. |

```jsonc
// follow from the start (pass threadId so the server can authorize you before the run row exists)
{ "type": "subscribe", "runId": "run_...", "threadId": "thr_..." }

// resume after a disconnect, from the last cursor you saw
{ "type": "subscribe", "runId": "run_...", "afterCursor": "..." }
```

Each `record` frame carries an `AgentRunStreamEvent`:

| Event | When | Fields |
| --- | --- | --- |
| `agent.run.started` | The turn began. | `modelId` |
| `agent.ui.chunk` | Live output as the model streams. | `chunkIndex`, `chunk` |
| `agent.message.finalized` | The assistant message was persisted. | `messageId` |
| `agent.run.finished` | The run ended. | `status`, `finishReason`, `error` |

Records carry a **cursor**. Persist the last one you saw and pass it as `afterCursor` to resume
where you left off — a client that reconnects mid-run replays the gap. `agent.ui.chunk` events are
live; the durable copy of the turn is the persisted assistant message, read back with
`GET /api/agent-threads/:threadId/messages`.

## Related

- [Defining agents](./defining-agents.md)
- [Authorization](./authorization.md) — who can create threads and run agents.
