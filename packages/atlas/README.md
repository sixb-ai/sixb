# @sixb/atlas

Built-in Atlas UI server for Sixb.

Atlas is a browser UI surface. It serves the public shell and static assets, injects the API origin
and auth audience at runtime, then lets the browser authenticate through `@sixb/server`.

## Usage

```typescript
import { createAtlasApp } from "@sixb/atlas"

const atlas = createAtlasApp({
  apiBaseUrl: "http://localhost:3000",
  audience: "atlas",
})

await atlas.start({ port: 3001 })
```

`@sixb/atlas` does not serve Sixb API routes. `/api`, `/auth`, `/ws`, and `/docs` belong to the
API origin owned by `@sixb/server`.

## Ontology graph

Relationships with multiple possible target types are counted on their source card instead of
drawing a line to every possible target in the overview. Select a target type to display those
incoming relationships, or select the source to browse all targets in the inspector. Relationships
with a single target and inheritance remain visible in the overview.
