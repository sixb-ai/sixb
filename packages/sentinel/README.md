# @pario/sentinel

Built-in Sentinel UI server for Pario workflow visibility.

Sentinel is a browser UI surface. It serves a public React shell, injects the API origin and auth audience at runtime, then lets the browser authenticate through `@pario/server`.

## Responsibilities

- List registered workflows from the Pario API.
- Show recent workflow run history.
- Link to workflow and run detail pages.
- Serve the Sentinel browser shell from its own origin.

Sentinel does not own workflow execution or workflow storage. Those live in `@pario/core`, `@pario/server`, and `@pario/workflow-worker`.

## Usage

```typescript
import { createSentinelApp } from "@pario/sentinel"

const sentinel = createSentinelApp({
  apiBaseUrl: "http://localhost:3002",
  audience: "sentinel",
})

await sentinel.start({ port: 3003 })
```

## Serving Model

`@pario/sentinel` serves its own built-in UI shell:

- hashed browser assets under `/__pario/*`
- runtime API/auth config injection
- `/favicon.svg` serving
- SPA fallback routes
- Tailwind CSS build/watch
- reserved route protection for `/api`, `/auth`, `/ws`, and `/docs`

Those reserved routes belong to the API origin owned by `@pario/server`.

## Browser UI

The React app under `src/ui/src/` remains Sentinel-specific. Shared visual primitives should go in `@pario/ui`.
