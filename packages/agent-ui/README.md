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
