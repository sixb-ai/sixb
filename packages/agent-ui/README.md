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
