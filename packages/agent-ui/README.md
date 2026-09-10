# @sixb/agent-ui

Shared Sixb agent chat UI for Atlas and custom apps.

The same conversation surface Atlas ships, packaged so a custom app can embed it. Threads, streaming
responses, tool calls, and ambient context are handled for you; routing is not, which is what lets the
component drop into an app that already owns its URLs.

## Install

```bash
bun add @sixb/agent-ui
```

Peer dependencies: `react`, `react-dom`, `@tanstack/react-query`, and — for the `/react-router`
subpath only — `react-router-dom`.

## Embedded panel

`AgentPanel` never reads or changes the host application's route. Use it for a sidebar or a drawer.

```tsx
import { AgentPanel } from "@sixb/agent-ui"
import "@sixb/agent-ui/globals.css"

export function InvoiceSidebar({ invoice }: { invoice: ObjectRef }) {
  return <AgentPanel context={[{ kind: "object", ref: invoice }]} />
}
```

| Prop | Purpose |
| --- | --- |
| `context` | Ambient context the agent sees. Omit it to inherit from `AgentContextProvider` instead; passing it makes the list fully controlled. |
| `threadId` | Controlled thread. Omit to let the panel own its current thread. |
| `defaultThreadId`, `onThreadChange` | For remembering where a user left off. |
| `welcomeContent` | Custom React content centered above the composer in an empty conversation. Omit for the default agent name and description tooltip; pass `null` to leave it empty. |

Use a logo, text, or your own component for the welcome area:

```tsx
<AgentPanel welcomeContent={<img src="/logo.svg" alt="Northline" className="h-10" />} />
```

The panel handles centering; your content controls its own styling. It disappears when the
conversation starts. `AgentChat` also accepts `welcomeContent`.

A context entry is either an object reference or a piece of app state:

```ts
{ kind: "object", ref: invoiceRef }
{ kind: "app-state", id: "filters", label: "Active filters", description: "…", value: { status: "open" } }
```

## Ambient context from anywhere in the tree

Wrap once, then let any descendant contribute context while it is mounted — the panel does not need to
know which components those are:

```tsx
import { AgentContextProvider, useAgentContext } from "@sixb/agent-ui"

function ProjectPage({ project }: { project: ObjectRef }) {
  useAgentContext({ kind: "object", ref: project })
  return <ProjectDetails />
}

<AgentContextProvider>
  <ProjectPage project={projectRef} />
  <AgentPanel />
</AgentContextProvider>
```

Registration follows mount and unmount, so context tracks what the user is actually looking at. Pass
`null` to contribute nothing. Panels that receive their own `context` prop ignore the ambient list.

## Full page, with routing

The `/react-router` subpath adds `AgentChatPage`, which wires conversation threads to real URLs, so
browser navigation and deep links work.

```tsx
import { AgentChatPage } from "@sixb/agent-ui/react-router"

<Route path="/agents/*" element={<AgentChatPage routeBase="/agents" />} />
```

`routeBase` defaults to `/agents` and must match the path you mount it on.

`AgentChatPage` covers the viewport and owns its responsive sidebar. Hosts can match that sidebar
to the rest of their app with `sidebarHeader`, `sidebarFooter`, and `sidebarWidth`. The header and
footer accept React nodes; the width accepts any React CSS width value and applies on desktop while
mobile keeps its responsive sheet width.

## Compose a custom UI

All chat building blocks are available as named imports from `@sixb/agent-ui`:

| Exports | Purpose |
| --- | --- |
| `AgentChat` | Complete route-independent workspace with navigation callbacks. |
| `ConversationPanel` | Conversation header, welcome state, transcript, and composer. |
| `Composer` | Chat input, uploads, context mentions, model controls, and send/stop buttons. |
| `Transcript` | Durable and streaming messages, optimistic user messages, scroll anchoring, and run status. |
| `MessageView`, `LiveAssistant`, `AssistantBody` | Individual messages, a live assistant row, or normalized assistant parts. |
| `ThreadSidebar` | Thread navigation with search and pagination callbacks. |
| `ContextPicker`, `ContextChips` | Context selection and selected context display. |
| `ModelControls`, `ModelPickerRow`, `ReasoningEffortSlider`, `ProviderLogo` | Model and reasoning selection. |
| `FileAttachmentCard`, `UserFileAttachment` | File attachments. |
| `ActivityStatusText`, `ThinkingMarker`, `CompactionMarker`, `ReconnectingMarker` | Live activity indicators. |
| `RunCancelledMarker`, `RunErrorMarker`, `RunFailureMarker`, `RunTimeoutMarker` | Run outcomes and recovery actions. |
| `DocumentPreviewRoot`, `useDocumentPreview` | Shared document viewer and programmatic preview controls. |

Use `useAgentConversation` once per conversation surface to share thread data, streaming state,
model selection, send/stop/retry actions, and failed-send draft restoration. The host owns `threadId`;
update it when `onThreadCreated` fires. Use `embedded: true` for a compact surface that does not need
the workspace-wide activity subscription.

The example below requires a configured Sixb client and a `QueryClientProvider` from
`@tanstack/react-query` above it. Load `@sixb/ui/globals.css` for the shared theme/Tailwind styles and
`@sixb/agent-ui/globals.css` for the agent component classes and animations.

```tsx
import { useState } from "react"
import {
  Composer,
  DocumentPreviewRoot,
  Transcript,
  useAgentConversation,
  useRegisteredAgentContext,
} from "@sixb/agent-ui"
import "@sixb/ui/globals.css"
import "@sixb/agent-ui/globals.css"

export function CustomChat() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const ambientContext = useRegisteredAgentContext()
  const chat = useAgentConversation({
    threadId,
    embedded: true,
    onThreadCreated: setThreadId,
  })
  const turn = chat.presentation
  const canRetry = turn.kind === "failed" || (turn.kind === "timeout" && !turn.hasProgress)

  if (chat.agentLoading) return <p role="status">Loading agent…</p>
  if (chat.agentError || !chat.currentAgent) return <p role="alert">Agent unavailable.</p>
  if (chat.threadUnavailable) return <p role="alert">Conversation unavailable.</p>

  return (
    <DocumentPreviewRoot compact scopeKey={threadId ?? "draft"} persistenceKey={threadId}>
      <section data-agent-panel="" className="flex h-full min-h-0 flex-col">
        <header>
          <h2>Project assistant</h2>
          <button type="button" onClick={() => setThreadId(null)}>New chat</button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          {chat.messagesLoading && <p role="status">Loading conversation…</p>}
          {chat.messagesError && <p role="alert">{chat.messagesError}</p>}
          <Transcript
            threadId={threadId}
            messages={chat.messages}
            live={chat.live}
            pendingUserText={chat.pendingUser?.text}
            pendingUserAttachments={chat.pendingUser?.attachments}
            pendingUserContext={chat.pendingUser?.context}
            anchorCurrentTurn={chat.anchorCurrentTurn}
            awaitingResponse={chat.isRunning}
            waitingLonger={chat.waitingLonger}
            reconnecting={chat.reconnecting}
            failedBeforeResponse={turn.kind === "failed"}
            cancelledBeforeResponse={turn.kind === "cancelled"}
            timeout={turn.kind === "timeout" ? turn : undefined}
            onRetry={canRetry ? () => chat.retry(turn.run) : undefined}
            onContinue={
              turn.kind === "timeout" && turn.hasProgress ? chat.continueAfterTimeout : undefined
            }
            retrying={chat.retrying}
            continuing={chat.composerPending}
          />
        </div>
        <Composer
          key={threadId ?? "draft"}
          compact
          onSend={chat.send}
          onStop={chat.stop}
          disabled={chat.isRunning}
          pending={chat.composerPending}
          running={chat.isRunning}
          stopping={chat.stopping}
          error={chat.sendError ?? undefined}
          draft={chat.draftReseed.text}
          draftAttachments={chat.draftReseed.attachments}
          draftContext={chat.draftReseed.context}
          draftNonce={chat.draftReseed.nonce}
          ambientContext={ambientContext}
          models={chat.models}
          modelsLoading={chat.modelsLoading}
          modelsError={chat.modelsError}
          selectedModel={chat.selectedModel}
          selectedReasoning={chat.selectedReasoning}
          onSelectModel={chat.selectModel}
          onSelectReasoning={chat.selectReasoning}
        />
      </section>
    </DocumentPreviewRoot>
  )
}
```

`useRegisteredAgentContext` reads entries contributed through `AgentContextProvider`; without a
provider it returns an empty list. Pass your own `ambientContext` to `Composer` when the host owns it.
`DocumentPreviewRoot` enables in-app attachment previews; without it, durable attachments use links.

You can also supply your own data/controller. `Transcript` accepts `AgentMessage[]` and `LiveRunState`;
`createLiveRunState()` supplies idle state for a non-streaming transcript. For custom message layouts,
use `MessageView` or pass `normalizeDurableParts(message.parts)` to `AssistantBody`.

Named types include `ComposerProps`, `TranscriptProps`, `ConversationPanelProps`, `ThreadSidebarProps`,
`ContextPickerProps`, `ContextPickerResult`, `ModelControlsProps`, `AgentConversation`,
`UseAgentConversationInput`, and the message, context, model, and normalized-part types. For components
with inline props, use React's `ComponentProps<typeof Component>`.

## Document previews

Durable files attached by a user or produced by an agent open directly from the conversation when
Sixb has a viewer for their format:

- Markdown uses the shared Sixb Markdown renderer.
- HTML is a static preview in a sandboxed iframe. Scripts, forms, network subresources, nested
  frames, app-origin access, and parent navigation are blocked; inline styles and data/blob media remain
  available.
- CSV and TSV render as a scrollable table. The preview is limited to 5 MB, 500 rows, and 50 columns;
  the original file remains available through Download.
- PDF uses the browser's native viewer and the contextual file route's range support.

On a desktop `AgentChatPage`, documents open beside the conversation in a resizable, tabbed pane.
`AgentPanel` and mobile chat use a large dialog instead. Unsupported formats keep the browser's
existing open/download behavior.

Preview tabs support Left/Right Arrow, Home, End, Delete, and Backspace. Closing the final document
returns focus to the attachment that opened the viewer.

### Host-provided document viewers

An application can add viewers for other formats without adding those implementations to this public
package. `agent-ui` keeps responsibility for the authenticated download, cache, loading and error
states, size limit, preview shell, and renderer isolation. The supplied component receives the
durable file metadata and its `Blob`:

```tsx
import { lazy } from "react"
import { AgentPanel, type AgentDocumentPreviewRenderer } from "@sixb/agent-ui"

const workbookPreviewRenderer = {
  id: "workbook-preview",
  maxFileSizeBytes: 25 * 1024 * 1024,
  supports: (file) =>
    file.mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.fileName?.toLowerCase().endsWith(".xlsx") === true,
  component: lazy(() => import("./WorkbookPreview")),
} satisfies AgentDocumentPreviewRenderer

<AgentPanel agentId="analyst" documentPreviewRenderers={[workbookPreviewRenderer]} />
```

The first matching host renderer handles the document, including formats with a built-in viewer.
Built-in viewers are the fallback. Keep `supports` synchronous and metadata-only. A renderer
implementation remains owned and explicitly registered by the host application.
