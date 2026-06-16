# @sixb/app

Reusable toolkit for project-specific Sixb apps. It owns custom app route scanning, entry generation, Bun dev serving, production builds, and serving built custom apps in production.

## Installation

```bash
bun add @sixb/app
```

## How It Works

The build pipeline has three stages: **scan**, **codegen**, and **build**.

### 1. Scan

`scanPages(appDir)` recursively walks `app/` looking for `page.tsx` (or `page.ts`) files and converts the file tree into React Router paths. Files and folders prefixed with `_` are ignored.

```
app/
  page.tsx                -> /
  about/page.tsx          -> /about
  remote/[id]/page.tsx    -> /remote/:id
```

### 2. Codegen

Two functions generate the entry point files into `.sixb/generated/`:

- **`generateRouteManifest(routes, generatedDir)`** -- writes `routes.ts` with a static import for each scanned page. Routes are eager on purpose: project apps bundle small, and a single bundle means no loading gap when navigating between pages.
- **`generateAppEntry(projectRoot, generatedDir, options)`** -- writes `index.html` (HTML shell) and `main.tsx` (React entry with BrowserRouter, TanStack Query, and the `@sixb/client` SDK).

The generated entry also intercepts plain same-origin `<a href="/...">` clicks and routes them client-side, so internal links work like react-router's `<Link>` without authors having to remember it. The interceptor is conservative — modified clicks, `target`/`download`/`rel="external"` anchors, cross-origin URLs, reserved Sixb paths (`/api`, `/auth`, `/ws`, `/docs`), and destinations that don't match an app route all keep native browser navigation. `<Link>` remains the idiomatic choice in app code.

If `app/layout.tsx` exists, it is used as a root layout wrapper. It can also export a `metadata` object (`title`, `description`, `favicon`) that is applied to the document at runtime. An `app/globals.css` file is imported automatically when present.

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

`buildApp(options)` runs `Bun.build()` on the generated HTML entry point to produce a minified, browser-targeted bundle with external source maps in `.sixb/dist/app/`. The output directory is build-owned and cleared before each build so stale hashed chunks don't accumulate.

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

Low-level pipeline:

```typescript
import {
  buildApp,
  generateAppEntry,
  generateRouteManifest,
  scanPages,
} from "@sixb/app"

const appDir = "./app"
const generatedDir = "./.sixb/generated"

const routes = await scanPages(appDir)
await generateRouteManifest(routes, generatedDir)
const { htmlPath } = await generateAppEntry(".", generatedDir, { appDir })
await buildApp({ entryPath: htmlPath })
```

## Public Assets

Static files in `app/public/` are served at root-relative paths:

- `app/public/logo.svg` serves at `/logo.svg`
- `app/public/models/macbook.glb` serves at `/models/macbook.glb`

In dev mode the Bun server serves them directly; in production they are copied into `.sixb/dist/app/`.

## Exports

| Export | Description |
| --- | --- |
| `createCustomApp(options)` | High-level custom app toolkit for dev/build/start |
| `scanPages(appDir)` | Scan `app/` for page files and return `PageRoute[]` |
| `generateRouteManifest(routes, generatedDir)` | Write `routes.ts` with static (eager) route imports |
| `generateAppEntry(projectRoot, generatedDir, options)` | Write `index.html` and `main.tsx` entry points |
| `buildApp(options)` | Bundle the generated entry point for production |
| `resolveCustomAppStylesheet(input)` | Decide whether `app/globals.css` is plain CSS or Tailwind source |
| `createTailwindCssCompiler(options)` | Shared Tailwind v4 build pipeline (also used by Atlas) |
| `resolveTailwindCliEntry(resolveFrom)` | Locate `@tailwindcss/cli` in a directory's dependency tree |
