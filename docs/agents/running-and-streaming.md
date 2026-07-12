# Running and streaming

A defined agent does nothing until a conversation drives it. You drive it over HTTP — create a
thread, post a message, follow the run — and stream the run live over a websocket.

## Threads, runs, and messages

- A **thread** is one conversation with one agent, owned by a principal. It has a status (`active`
  or `archived`) and an ordered list of messages.
- A **run** is one turn. Posting a user message to a thread triggers a run.
- A **message** has a `role` (`system`, `user`, `assistant`) and structured `parts`: `text`,
  `reasoning`, `step-start`, `tool-call`, and `file`. The assistant message is persisted once the
  run finishes.

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
| `GET` | `/api/agent-threads/:threadId/runs` | List a thread's runs. |
| `POST` | `/api/agent-threads/:threadId/runs/:runId/retry` | Retry a failed run without adding another user message. |
| `POST` | `/api/agent-threads/:threadId/cancel` | Cancel the thread's queued or running run (`{ runId }`). |
| `GET` | `/api/agent-runs/:runId` | Get a run's status. |
| `GET` | `/api/agent-threads/:threadId/messages/:messageId/files/content` | Download a file attached to a message. |

## Trigger a run

There is no separate run-trigger endpoint — posting a message is the trigger. The `202` response
returns the canonical durable run:

```jsonc
// POST /api/agent-threads/:threadId/messages   { "text": "Which invoices are overdue?" }
{
  "run": {
    "id": "run_...",
    "threadId": "thr_...",
    "agentId": "accounts",
    "triggerMessageId": "msg_...",
    "requestedByPrincipal": { "type": "user", "id": "usr_..." },
    "status": "queued",
    "attempt": 0,
    "streamId": "agents.runs.run_...",
    "createdAt": "2026-07-11T20:00:00.000Z"
  }
}
```

The run and user message are durable before this response returns, so you can immediately read the
run or subscribe to its stream even when queue publication is temporarily unavailable.
A thread runs **one turn at a time** — posting while a run is active returns `409`; wait for it to
finish first.

### Attachments

A user message can carry files: pass `attachments` — an array of `FileRef`s, the same blob
references [objects](../objects/overview.md) use — alongside `text`.

```jsonc
// POST /api/agent-threads/:threadId/messages
{ "text": "Summarize this contract", "attachments": [ /* FileRef */ ] }
```

Attachments — and any files the agent produces — appear as `file` parts on the stored message
(`{ "type": "file", "fileRef": … }`). Download the bytes from
`GET /api/agent-threads/:threadId/messages/:messageId/files/content`.

## Run status

`GET /api/agent-runs/:runId` returns the run record.

| Status | Meaning |
| --- | --- |
| `queued` | The request is durable and waiting to start. |
| `running` | The turn is in progress. |
| `succeeded` | The turn completed and the reply was persisted. |
| `failed` | A model/tool error or the turn timeout ended it (`error` has details). |
| `cancelled` | The run was aborted. |

A finished run also carries `finishReason` (`stop`, `length`, `tool-calls`, `content-filter`,
`error`, `other`, `unknown`), `usage` token counts (`inputTokens`, `outputTokens`, `totalTokens`,
`reasoningTokens`, `cachedInputTokens`), and `modelId`.

Cancel a queued or running run with `POST /api/agent-threads/:threadId/cancel` (body `{ runId }`);
it ends as `cancelled`.

Retrying a failed run creates a new queued run that points to the failed run's existing
`triggerMessageId`. The original user message is not appended again.

## Stream a run

Connect to `/ws/agents` and send JSON commands; the server replies with JSON events.

| Command | Fields | Purpose |
| --- | --- | --- |
| `subscribe` | `runId`, `afterCursor?` | Follow a run live. |
| `replay` | `runId`, `afterCursor?`, `limit?` | Read past records once. |
| `unsubscribe` | `runId?` | Stop the subscription. |

```jsonc
// follow from the start
{ "type": "subscribe", "runId": "run_..." }

// resume after a disconnect, from the last cursor you saw
{ "type": "subscribe", "runId": "run_...", "afterCursor": "..." }
```

After replaying retained records, the server sends a `run.snapshot` frame containing the current
durable run. A new run therefore streams `status: "queued"` before any worker lifecycle record, and
a reconnect can recover terminal state even if no live record was observed.

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

## A ready-made chat UI

You rarely need to wire this HTTP + WebSocket flow by hand. `@sixb/agent-ui` ships a turnkey React
chat: `AgentChat` (a full thread with composer and live transcript), `AgentsHome` (an agent
picker), and the `Composer`, `Transcript`, and streaming hooks as building blocks. For a
React-Router app, `@sixb/agent-ui/react-router` exposes a drop-in `AgentChatPage`:

```tsx
import { AgentChatPage } from "@sixb/agent-ui/react-router"

export default function Agents() {
  return <AgentChatPage routeBase="/agents" />
}
```

Import `@sixb/agent-ui/globals.css` once for styling. These components call the same `/api/agent-*`
routes and `/ws/agents` stream documented above, so anything they do is reachable from your own
client too.

## Related

- [Defining agents](./defining-agents.md)
- [Authorization](./authorization.md) — who can create threads and run agents.
- [Building apps](../apps/overview.md) — mounting the `@sixb/agent-ui` chat in a custom app.
