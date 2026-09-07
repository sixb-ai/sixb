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
  return <AgentPanel agentId="billing-assistant" context={[{ kind: "object", ref: invoice }]} />
}
```

| Prop | Purpose |
| --- | --- |
| `agentId` | The agent this panel talks to. |
| `context` | Ambient context the agent sees. Omit it to inherit from `AgentContextProvider` instead; passing it makes the list fully controlled. |
| `threadId` | Controlled thread. Omit to let the panel own its current thread. |
| `defaultThreadId`, `onThreadChange` | For remembering where a user left off. |
| `centerEmptyState`, `hideHeaderOnEmpty` | Turn a new draft into a focused landing composer. |
| `emptyStateHeader`, `emptyStateFooter` | Add host branding and shortcuts around that composer. |
| `composerPlaceholder` | Customize the prompt shown in the empty composer. |

A context entry is either an object reference or a piece of app state:

```ts
{ kind: "object", ref: invoiceRef }
{ kind: "app-state", id: "filters", label: "Active filters", description: "…", value: { status: "open" } }
```

When app state also contains host-only runtime metadata, provide a safe `modelValue` projection.
The full `value` remains durable for host integrations, while only `modelValue` is included in
model input.

## Adaptive app surface

`AgentSurface` keeps one `AgentPanel` mounted while it moves between a launcher, compact dock, and
host-routed full-page presentation. It owns its dock state by default, while the host route decides
when that same session fills the page. The active conversation, drafts, and scroll position survive
the transition.

```tsx
import { AgentSurface } from "@sixb/agent-ui"

export function AppAssistant() {
  return (
    <AgentSurface
      agentId="operations-assistant"
      title="Operations Assistant"
      launcherLabel="Ask Operations"
    />
  )
}
```

Opening a supported conversation document shows a modeless tabbed canvas over the application area
while the dock stays visible and interactive. Hiding the canvas preserves its tabs; closing an
individual tab removes that file. The corresponding conversation card is highlighted while its tab
is selected, and clicking that selected card closes the file. The dock uses one compact header with
collapse, thread history, and one-click compose controls. It opens by default and owns its
open/closed state, width, and current thread. Those values live in `sessionStorage`, so they survive
refresh while remaining independent
between tabs; the host application's URL stays untouched. Drag the dock's left edge to resize it.
The thread switcher keeps the current conversation separate from date-grouped history. Mobile keeps
a full-screen dock and uses a modal document overlay.

Set `fullPage` from the host's conversation route to expand the same mounted session over its
positioned container. Use `onRequestFullPage` and `onRequestDock` to connect the built-in expand and
minimize controls to navigation. Leaving the conversation route naturally returns the session to
its dock; full-page presentation is never persisted as assistant state.

Pass controlled `mode`, `threadId`, or `dockWidth` props when the host needs to own one of those
values. Set `persistenceKey={false}` to disable the default per-tab persistence.

A separate landing `AgentPanel` can call `handoffAgentSurfaceThread(agentId, threadId)` from its
`onThreadChange` callback. The next mounted dock in that browser tab opens on the same durable
thread without adding assistant state to the host URL.

Use `AgentChatPage` when an application needs a standalone routed full-page conversation.

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
  <AgentPanel agentId="project-assistant" />
</AgentContextProvider>
```

Registration follows mount and unmount, so context tracks what the user is actually looking at. Pass
`null` to contribute nothing. Panels that receive their own `context` prop ignore the ambient list.

## Full page, with routing

The `/react-router` subpath adds `AgentChatPage`, which wires the conversation to real URLs —
thread and draft ids live in the route, so browser navigation and deep links work.

```tsx
import { AgentChatPage } from "@sixb/agent-ui/react-router"

<Route path="/agents/*" element={<AgentChatPage routeBase="/agents" />} />
```

`routeBase` defaults to `/agents` and must match the path you mount it on.

`AgentChatPage` covers the viewport and uses the same conversation header, thread-history dialog,
and new-thread flow as an embedded panel.

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
`AgentSurface` uses a modeless canvas beside its dock; a standalone `AgentPanel` and mobile chat use
a large dialog instead. Closing a viewer keeps its tabs available when a file is opened again. The
active file card in the transcript acts as a close toggle for its selected tab. Unsupported formats
keep the browser's existing open/download behavior.

Preview tabs support Left/Right Arrow, Home, End, Delete, and Backspace. Closing the final document
returns focus to the attachment that opened the viewer.
