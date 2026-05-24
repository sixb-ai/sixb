# @pario/atlas

Built-in Atlas UI server for Pario.

Atlas is a browser UI surface. It serves the public shell and static assets, injects the API origin
and auth audience at runtime, then lets the browser authenticate through `@pario/server`.

## Usage

```typescript
import { createAtlasApp } from "@pario/atlas"

const atlas = createAtlasApp({
  apiBaseUrl: "http://localhost:3000",
  audience: "atlas",
})

await atlas.start({ port: 3001 })
```

`@pario/atlas` does not serve Pario API routes. `/api`, `/auth`, `/ws`, and `/docs` belong to the
API origin owned by `@pario/server`.
