# Built-in Agent

Integrate Sixb's conversational Agent through the execution SDK, HTTP API, or ready-made chat UI.

## Configure

File: `sixb.config.ts`

```ts
import { createSixb } from "@sixb/core"
import { vercelGateway } from "@sixb/vercel-ai-gateway"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"

export const sixb = createSixb({
  // ...your existing providers
  models: { language: [vercelGateway("openai/gpt-5.5")] },
  sandboxes: new SmolvmSandboxFactory(),
})
```

```bash
bun sixb dev
```

| Requirement | Purpose |
| --- | --- |
| Language model | First configured binding is the default |
| Sandbox factory | Isolated `read`, `bash`, and `view_file` tools |
| Agent worker | Executes turns; cohosted by `sixb dev` |
| Agent API origin | Run-scoped gateway to the project API |

Project `tools` and `skills/` extend the Agent. See [Tools and Authorization](./tools-and-authorization.md).

## Start a conversation

Use the request-bound SDK to retain the authenticated caller's authority.

```ts
const thread = await sixb.agent.threads.create({ title: "Invoice review" })

const { run } = await sixb.agent.runs.request({
  threadId: thread.id,
  text: "Which invoices are overdue?",
})
```

```text
Thread → User message → Queued run → Tool/model calls → Saved assistant message
```

| Concept | Meaning |
| --- | --- |
| Thread | Owner-scoped conversation with ordered messages |
| Run | One turn; only one active turn per thread |
| Message | Role plus text, reasoning, tool-call, and file parts |

## HTTP API

```jsonc
// POST /api/agent-threads
{ "title": "Invoice review" }

// POST /api/agent-threads/:threadId/messages — creates a run
{ "text": "Which invoices are overdue?" }

// Attach files using uploaded FileRefs
{ "text": "Summarize this contract", "attachments": [ /* FileRef */ ] }
```

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/agent` | Project Agent descriptor |
| `GET`, `POST` | `/api/agent-threads` | List / create threads |
| `GET` | `/api/agent-threads/:threadId` | Read a thread |
| `GET`, `POST` | `/api/agent-threads/:threadId/messages` | Read messages / trigger a turn |
| `GET` | `/api/agent-threads/:threadId/runs` | List turns |
| `GET` | `/api/agent-runs/:runId` | Read run status |
| `POST` | `/api/agent-threads/:threadId/runs/:runId/retry` | Retry a failed turn |
| `POST` | `/api/agent-threads/:threadId/cancel` | Cancel; body `{ "runId": "..." }` |
| `GET` | `/api/agent-threads/:threadId/messages/:messageId/files/content` | Download an attachment |

Posting a message returns `202` with `{ run }` after the run and message are durable. Posting while a turn is active returns `409`.

## Run status

| Status | Meaning |
| --- | --- |
| `queued` | Durable and waiting to start |
| `running` | Turn in progress |
| `succeeded` | Reply persisted |
| `failed` | Provider/tool error or timeout; inspect `error` |
| `cancelled` | Turn aborted |

Finished runs expose `finishReason`, `modelId`, and ledger-derived `usage`. `requestedBy` identifies the original requester when present. See [Usage and limits](./usage-and-limits.md) for call costs.

## Stream a run

```ts
const socket = new WebSocket("ws://localhost:3002/ws/agents")

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ type: "subscribe", runId: run.id }))
})

socket.addEventListener("message", ({ data }) => {
  const frame = JSON.parse(data)
  // Handle run snapshots and streamed records.
})
```

| Command | Fields |
| --- | --- |
| `subscribe` | `runId`, optional `afterCursor` |
| `replay` | `runId`, optional `afterCursor` and `limit` |
| `unsubscribe` | Optional `runId` |

```jsonc
// Reconnect using the last record cursor received.
{ "type": "subscribe", "runId": "run_...", "afterCursor": "..." }
```

| Frame / event | Use |
| --- | --- |
| `run.snapshot` | Restore current durable run state after replay |
| `agent.run.started` | Show the selected model |
| `agent.ui.chunk` | Render live text, reasoning, and tool activity |
| `agent.message.finalized` | Read the saved assistant message |
| `agent.run.finished` | Show terminal status and finish reason |
| `agent.compaction.started/completed/failed` | Show context-compaction progress |

Persist the last record cursor. An expired cursor restarts from the oldest retained record and returns `afterCursor: null` in the `subscribed` frame. Saved messages remain available through HTTP; compaction events contain no summary text.

## Chat UI

File: `app/agents/page.tsx`

```tsx
import { AgentChatPage } from "@sixb/agent-ui/react-router"

export default function AgentPage() {
  return <AgentChatPage routeBase="/agents" />
}
```

Import `@sixb/agent-ui/globals.css` once in your app's stylesheet setup.

| Export | Use |
| --- | --- |
| `AgentChatPage` | React-Router chat page |
| `AgentPanel` | Embedded chat |
| `Composer`, `Transcript`, streaming hooks | Custom chat layout |

See [Building apps](../apps/overview.md) for mounting the UI.

## Conversation limits

| Behavior | Default |
| --- | --- |
| Model calls per turn | 100 steps, with a tool-free final-answer instruction on the last step |
| Turn timeout | 10 minutes |
| Long conversation | Summary plus recent turns as model input; full transcript preserved |
| Missing context metadata | 128,000-token fallback with a warning |
| Model switching | Explicit selection; Sixb never switches automatically |

At timeout, a coherent partial reply is saved when available. Offer **Continue** when it exists; otherwise offer retry. Retry creates a new run using the original user message. Completed tool side effects are not undone.

Workflow tool-driven tasks use [`defineAgentStep()`](../workflows/overview.md#define-agent-tasks), with their own prompt, tools, and groups.
