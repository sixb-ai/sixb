# Get started

Scaffold a Sixb project, run it, and trace live orbital data from a connector into a typed object
and custom app. By the end you will have a local runtime tracking Sentinel-6B and understand how
Sixb moves external data into the model your app reads.

Sixb requires Bun 1.3 or later. Install [Bun](https://bun.sh) first.

## Scaffold a project

```bash
bun create sixb my-app
cd my-app
bun install
```

The generated starter locates Sentinel-6B from public orbital elements. It uses local SQLite,
DuckLake, and file storage, so no database or service needs to be running before you start.

| Path | What it is |
| --- | --- |
| `sixb.config.ts` | Runtime entry with local providers |
| `connectors/celestrak.ts` | Keyless connection to the public CelesTrak TLE endpoint |
| `datasets/satellite-orbit.ts` | Typed table for an orbital snapshot |
| `syncs/satellite-orbit.ts` | Pulls the latest snapshot into the dataset |
| `ontology/satellite.ts` | Typed `Satellite` object model |
| `projections/satellite.ts` | Maps the dataset row into a `Satellite` object |
| `app/page.tsx` | Custom app that queries the object and calculates its live position |

## Start the dev server

```bash
bun run dev
```

The local `dev` script runs `sixb dev`. It loads `sixb.config.ts`, co-hosts the runtime and workers,
and serves three interfaces:

| Service | URL | Purpose |
| --- | --- | --- |
| Atlas | `http://localhost:3000` | Browse the ontology, objects, runs, and events |
| Starter app | `http://localhost:3001` | Locate Sentinel-6B and follow its live position |
| API | `http://localhost:3002` | HTTP/WebSocket API and interactive OpenAPI docs |

Keep this terminal running while you use the app.

## Locate Sentinel-6B

Open `http://localhost:3001` and select **Locate**. That one request runs the whole starter data
path:

1. The `celestrak` connector fetches the current two-line element set for Sentinel-6B.
2. `sync-satellite-orbit` writes one typed row into the `satellite-orbit` dataset.
3. The `satellite` projection materializes that row as a `Satellite` object.
4. The app's typed object query refreshes when the object event arrives.
5. The browser calculates latitude, longitude, altitude, and velocity from the saved elements.

The fetch needs outbound internet access but no account or API key. The app does not fetch on
startup; it stays in **Ready to locate** until you select the button.

## Inspect the object model

Object types live in `ontology/` and are auto-discovered. The starter declares the data the app and
projection share in one place.

File: `ontology/satellite.ts`

```ts
import { defineObjectType, prop } from "@sixb/core/ontology"

export const Satellite = defineObjectType({
  id: "Satellite",
  name: "Satellite",
  description: "A spacecraft located from public orbital elements.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("tleLine1", "string", { required: true }),
    prop("tleLine2", "string", { required: true }),
    prop("elementEpoch", "timestamp", { required: true }),
  ],
})
```

Every object type needs exactly one `primary: true` property as its key. The same definition types
the projection, runtime queries, client query, API schema, and Atlas views. See
[object types](ontology/object-types.md) and [properties](ontology/properties.md) for every option.

## Inspect the sync and projection

The sync converts the connector response into the dataset's row shape:

File: `syncs/satellite-orbit.ts`

```ts
import { defineSync } from "@sixb/core"
import { celestrak } from "../connectors/celestrak"
import { satelliteOrbit } from "../datasets/satellite-orbit"

export const syncSatelliteOrbit = defineSync("sync-satellite-orbit")
  .from(celestrak)
  .read(async (client, context) => {
    const orbit = await client.latestOrbit(context.signal)
    return [
      {
        id: "sentinel-6b",
        name: orbit.name,
        tleLine1: orbit.line1,
        tleLine2: orbit.line2,
        elementEpoch: orbit.elementEpoch,
      },
    ]
  })
  .intoDataset(satelliteOrbit)
```

The projection then maps each column to the object property with the same name:

File: `projections/satellite.ts`

```ts
import { defineProjection, type ObjectProjectionDefinition } from "@sixb/core"
import { satelliteOrbit } from "../datasets/satellite-orbit"
import { Satellite } from "../ontology/satellite"

export const satelliteProjection: ObjectProjectionDefinition = defineProjection(
  "satellite",
  Satellite
)
  .fromDataset(satelliteOrbit)
  .properties({
    id: "id",
    name: "name",
    tleLine1: "tleLine1",
    tleLine2: "tleLine2",
    elementEpoch: "elementEpoch",
  })
```

Open `http://localhost:3000` after the first locate request to inspect the registered `Satellite`
type, the materialized object, and the runs that produced it.

## Next steps

- [Project structure](fundamentals/project-structure.md) — discovery and every convention folder
- [Ontology](ontology/overview.md) — model your own domain
- [Syncs](data/syncs.md), [datasets](data/datasets.md), and
  [projections](data/projections.md) — follow the complete data path
- [Objects](objects/overview.md) — read, write, and query materialized objects
- [Building apps](apps/overview.md) — build a typed interface on the same model
- [Actions](actions/overview.md) — add controlled commands that change object state
- [Manual install](fundamentals/manual-install.md) — add Sixb to an existing project
