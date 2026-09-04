# @sixb/app

Reusable toolkit for project-specific Sixb apps. It owns custom app route scanning, entry generation, Bun dev serving, production builds, and serving built custom apps in production.

## Installation

```bash
bun add @sixb/app
```

## How It Works

The build pipeline has three stages: **scan**, **codegen**, and **build**.

### 1. Scan

The internal scanner recursively walks `app/` for `page.tsx` (or `page.ts`) files and descendant
`layout.tsx` files. It converts the file tree into nested React Router routes. Files and folders
prefixed with `_`, plus the static `app/public/` tree, are ignored.

```
app/
  page.tsx                -> /
  about/page.tsx          -> /about
  about/layout.tsx        -> wraps /about and its descendants
  remote/[id]/page.tsx    -> /remote/:id
  remote/[id]/layout.tsx  -> wraps /remote/:id and its descendants
```

### 2. Codegen

Two functions generate the entry point files into `.sixb/generated/`:

- **`generateRouteManifest(routes, generatedDir)`** -- writes `routes.ts` with static page and
  layout imports plus native nested `RouteObject` entries. Routes are eager on purpose: project
  apps bundle small, and a single bundle means no loading gap when navigating between pages.
- **`generateAppEntry(projectRoot, generatedDir, options)`** -- writes `index.html` (HTML shell), `main.tsx` (React entry with BrowserRouter, TanStack Query, and the `@sixb/client` SDK), and `app.webmanifest`.

The generated entry also intercepts plain same-origin `<a href="/...">` clicks and routes them client-side, so internal links work like react-router's `<Link>` without authors having to remember it. The interceptor is conservative — modified clicks, `target`/`download`/`rel="external"` anchors, cross-origin URLs, reserved Sixb paths (`/api`, `/auth`, `/ws`, `/docs`), and destinations that don't match an app route all keep native browser navigation. `<Link>` remains the idiomatic choice in app code.

If `app/layout.tsx` exists, it is the global wrapper outside the route tree. It can also export a
`metadata` object (`title`, `description`, `favicon`, `themeColor`, and `backgroundColor`). Metadata
is loaded during generation and written into the static HTML and manifest, so it is available
before auth and client startup. The root layout module must therefore be import-safe in Bun: do
not access `window` or `document` at module scope. An `app/globals.css` file is imported
automatically when present.

A descendant `app/**/layout.tsx` wraps only pages at its URL prefix. It receives `children`, can use
React Router hooks such as `useParams`, and stays mounted while navigation remains inside its
subtree. Descendant layout metadata is not read. A layout with no project or framework page below
it creates no route and is not bundled.

Add an optional `app/auth.tsx` default export to customize the app audience's magic-link pages. It receives `AuthExperienceProps` from `@sixb/app/auth` with `signIn`, `checkEmail`, `confirm`, `invalidLink`, and `error` states plus framework-owned actions. Sixb builds it separately, includes `app/globals.css`, and serves it from the API's existing `/auth/*` routes. It is not wrapped by `app/layout.tsx`, and it never owns tokens, cookies, callbacks, audience validation, or return redirects. When the file is absent, the generic server login remains the fallback.

### Built-in Agent Routes

Custom apps automatically receive the shared Sixb agent chat UI at:

```
/agents
/agents/new/:agentId
/agents/:threadId
```

These routes are generated only when the project has at least one `app/` page, so projects without a custom app are not turned into an app server just for agents. Project-authored pages win by exact path: define `app/agents/page.tsx` to replace the gallery, `app/agents/new/[agentId]/page.tsx` to replace the blank chat route, and `app/agents/[threadId]/page.tsx` to replace the thread route.

The default agent UI is imported through `@sixb/app/agents`, so app projects do not need to import `@sixb/agent-ui` directly. A framework-owned `agent-ui.css` bundle is generated before the app stylesheet and imports normal `@sixb/ui` styles, which means app-level token overrides in `app/globals.css` still apply in the usual way.

Add `app/agents/layout.tsx` with `AgentWorkspaceProvider` to make the built-in agent navigation
match the custom app shell without making the provider global or replacing any routes:

```tsx
import { AgentWorkspaceProvider } from "@sixb/app/agents"
import type { PropsWithChildren } from "react"

export default function AgentsLayout({ children }: PropsWithChildren) {
  return (
    <AgentWorkspaceProvider
      sidebarHeader={<AppSidebarHeader />}
      sidebarFooter={<AppSidebarFooter />}
      sidebarWidth="12.5rem"
    >
      {children}
    </AgentWorkspaceProvider>
  )
}
```

Explicit props passed to a project-owned `AgentsPage` override provider defaults. The custom width
applies to the persistent desktop rail; the mobile sheet keeps its responsive width.

### Embedded Agent Panel

Embed the same conversation runtime without changing the page route:

```tsx
import {
  AgentContextProvider,
  AgentPanel,
  agentContext,
  useAgentContext,
} from "@sixb/app/agents"

function InvoicePage({ invoiceId }: { invoiceId: string }) {
  useAgentContext(agentContext.object(Invoice, invoiceId))
  return <InvoiceDetails invoiceId={invoiceId} />
}

function Layout() {
  return (
    <AgentContextProvider>
      <main><InvoicePage invoiceId="inv-123" /></main>
      <aside className="h-[42rem]">
        <AgentPanel />
      </aside>
    </AgentContextProvider>
  )
}
```

`AgentPanel.context` is controlled: when provided, it replaces provider context. `threadId` and
`onThreadChange` similarly opt into controlled thread state.

```tsx
const view = agentContext.appState("invoice-view", {
  label: "Invoice view",
  description: "Current invoice filters and selected tab",
  value: { activeTab, filters },
})

<AgentPanel context={[view]} />
```

Context is visible and removable before send, then stored on that user message. `@` adds authorized
object references explicitly. V1 accepts 12 entries, 16 KB per app-state entry, and 64 KB of app
state per message. Object references identify live data; they do not grant access.

### Styling and Tailwind

`app/globals.css` is treated as source:

- **Plain CSS** is bundled as-is.
- **Tailwind v4 source** — a file using Tailwind at-rules (`@source`, `@theme`, `@apply`, ...) or importing package CSS such as `@import "@sixb/ui/globals.css"` — is compiled with the project's `@tailwindcss/cli` to `.sixb/generated/app.css`, and the generated entry imports the compiled output. Compilation runs during both dev and build, so `sixb build` alone always produces fresh production CSS, and `dev()` recompiles on `.css`/`.ts`/`.tsx` changes without any userland watcher.

A typical Tailwind + `@sixb/ui` setup is just:

```css
/* app/globals.css */
@import "@sixb/ui/globals.css";
@source "./**/*.{ts,tsx}";
```

Tailwind's source detection is scoped to `app/`, and the CLI is resolved from the project's own dependencies (`bun add tailwindcss @tailwindcss/cli`). If `globals.css` uses Tailwind features but the CLI is missing, dev and build fail with an actionable `[SixbCustomApp]` error.

### 3. Build

`buildApp(options)` runs `Bun.build()` on the generated HTML entry point to produce a minified, browser-targeted bundle with external source maps in `.sixb/dist/app/`. Pass the generated `manifestPath` to copy the framework manifest to the stable output URL. The output directory is build-owned and cleared before each build so stale hashed chunks don't accumulate.

### 4. Start

`createCustomApp().start(options)` serves the built app from `.sixb/dist/app/` on a Bun server. When `apiBaseUrl` is provided, it is injected into the served HTML at runtime so the public custom app shell can call the Sixb API origin with credentials.

## Usage

Preferred high-level API:

```typescript
import { createCustomApp } from "@sixb/app"

const app = await createCustomApp({
  rootDir: process.cwd(),
  apiBaseUrl: "http://localhost:3000",
  audience: "app",
})

await app.dev({ port: 3001 })
await app.build({ outdir: ".sixb/dist/app" })
await app.start({ port: 3001, outdir: ".sixb/dist/app", apiBaseUrl: "http://localhost:3000" })
```

The low-level pipeline (`scanPages`, `generateRouteManifest`, `generateAppEntry`,
`buildApp`) is internal — `createCustomApp` composes it. Only the surface above is
exported.

## Public Assets

Static files in `app/public/` are served at root-relative paths:

- `app/public/logo.svg` serves at `/logo.svg`
- `app/public/models/macbook.glb` serves at `/models/macbook.glb`

In dev mode the Bun server serves them directly; in production they are copied into `.sixb/dist/app/`.

Custom apps are PWAs by default. Sixb owns `/app.webmanifest`, emits `display: "standalone"`, and recognizes these optional files in `app/public/`:

| File | Purpose |
| --- | --- |
| `favicon.svg` | Browser favicon and manifest fallback |
| `icon-192.png` | 192x192 install icon |
| `icon-512.png` | 512x512 install icon |
| `icon-maskable-512.png` | 512x512 adaptive icon with artwork in the 80% safe zone |
| `apple-touch-icon.png` | 180x180 opaque iOS Home Screen icon |

A file at `app/public/app.webmanifest` is ignored because the generated manifest is framework-owned. The manifest is served with `no-cache`; fixed-name public icons are not given immutable caching. In standalone mode Sixb suppresses root overscroll without hiding overflow or preventing normal document scrolling.

## Exports

| Export | Description |
| --- | --- |
| `createCustomApp(options)` | High-level custom app toolkit for dev/build/start |
| `AppMetadata` | Metadata shape exported by `app/layout.tsx` |
| `@sixb/app/auth` | Custom auth experience states, actions, and component props |
| `createTailwindCssCompiler(options)` | Shared Tailwind v4 build pipeline (also used by Atlas) |
| `@sixb/app/agents` | Full-page agent route plus `AgentPanel`, context provider/hooks, and helpers |
