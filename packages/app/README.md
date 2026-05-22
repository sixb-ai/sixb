# @pario/app

Reusable toolkit for project-specific Pario apps. It owns custom app route scanning, entry generation, Bun dev serving, production builds, and technical app mounts consumed by `@pario/server`.

## Installation

```bash
bun add @pario/app
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

Two functions generate the entry point files into `.pario/generated/`:

- **`generateRouteManifest(routes, generatedDir)`** -- writes `routes.ts` with lazy-loaded imports for each scanned page.
- **`generateAppEntry(projectRoot, generatedDir, options)`** -- writes `index.html` (HTML shell) and `main.tsx` (React entry with BrowserRouter, TanStack Query, and the `@pario/client` SDK).

If `app/layout.tsx` exists, it is used as a root layout wrapper. It can also export a `metadata` object (`title`, `description`, `favicon`) that is applied to the document at runtime. An `app/globals.css` file is imported automatically when present.

### 3. Build

`buildApp(options)` runs `Bun.build()` on the generated HTML entry point to produce a minified, browser-targeted bundle with external source maps in `.pario/dist/app/`.

### 4. Serve

The preferred production model is same-origin serving through `@pario/server`: the custom app shell, `/api/*`, `/auth/*`, `/ws/*`, and `/docs` are all available on the same visible app origin.

`createParioApp().createDevMount()` and `createParioApp().createProductionMount()` expose technical app resources used by the server. They declare exact assets, dev proxy prefixes, HMR paths, and production HTML lookup helpers; `@pario/server` owns the auth and routing policy.

`createParioApp().start(options)` still serves the built app directly from `.pario/dist/app/`. Treat it as an advanced standalone/static-hosting helper. When `apiBaseUrl` is provided, it is injected into runtime config so a separately hosted custom app can target another Pario API origin.

## Usage

Preferred high-level API:

```typescript
import { createParioApp } from "@pario/app"

const app = await createParioApp({
  rootDir: process.cwd(),
})

await app.build({ outdir: ".pario/dist/app" })

const devMount = await app.createDevMount()
const productionMount = await app.createProductionMount({ outdir: ".pario/dist/app" })
```

Standalone helpers:

```typescript
await app.dev({ port: 3001 })
await app.start({
  port: 3001,
  outdir: ".pario/dist/app",
  apiBaseUrl: "http://localhost:3000",
})
```

Low-level pipeline:

```typescript
import {
  buildApp,
  generateAppEntry,
  generateRouteManifest,
  scanPages,
} from "@pario/app"

const appDir = "./app"
const generatedDir = "./.pario/generated"

const routes = await scanPages(appDir)
await generateRouteManifest(routes, generatedDir)
const { htmlPath } = await generateAppEntry(".", generatedDir, { appDir })
await buildApp({ entryPath: htmlPath })
```

## Public Assets

Static files in `app/public/` are served at root-relative paths:

- `app/public/logo.svg` serves at `/logo.svg`
- `app/public/models/macbook.glb` serves at `/models/macbook.glb`

In dev mode the Bun server serves them directly; in production they are copied into `.pario/dist/app/`.

## Exports

| Export | Description |
| --- | --- |
| `createParioApp(options)` | High-level custom app toolkit for dev/build/start/mounts |
| `CustomAppMount` | Technical app mount consumed by `@pario/server` |
| `scanPages(appDir)` | Scan `app/` for page files and return `PageRoute[]` |
| `generateRouteManifest(routes, generatedDir)` | Write `routes.ts` with lazy-loaded route imports |
| `generateAppEntry(projectRoot, generatedDir, options)` | Write `index.html` and `main.tsx` entry points |
| `buildApp(options)` | Bundle the generated entry point for production |
