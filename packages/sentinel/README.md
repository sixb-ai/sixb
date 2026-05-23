# @sixb/sentinel

Built-in Sentinel UI server for Sixb workflow visibility.

Sentinel is a browser UI surface. It serves a public React shell, injects the API origin and auth audience at runtime, then lets the browser authenticate through `@sixb/server`.

## Responsibilities

- List registered workflows from the Sixb API.
- Show recent workflow run history.
- Link to workflow and run detail pages.
- Serve the Sentinel browser shell from its own origin.

Sentinel does not own workflow execution or workflow storage. Those live in `@sixb/core`, `@sixb/server`, and `@sixb/workflow-worker`.

## Usage

```typescript
import { createSentinelApp } from "@sixb/sentinel"

const sentinel = createSentinelApp({
  apiBaseUrl: "http://localhost:3002",
  audience: "sentinel",
})

await sentinel.start({ port: 3003 })
```

## Serving Model

`@sixb/sentinel` serves its own built-in UI shell:

- hashed browser assets under `/__sixb/*`
- runtime API/auth config injection
- `/favicon.svg` serving
- SPA fallback routes
- Tailwind CSS build/watch
- reserved route protection for `/api`, `/auth`, `/ws`, and `/docs`

Those reserved routes belong to the API origin owned by `@sixb/server`.

## Browser UI

The React app under `src/ui/src/` remains Sentinel-specific. Shared visual primitives should go in `@sixb/ui`.
