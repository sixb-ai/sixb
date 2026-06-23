# @sixb/connector-companycam

A small CompanyCam connector for Sixb, built on `@sixb/connector-rest`.

- **Projects** — list, get, list a project's photos
- **Photos** — list (across projects), get
- **Webhooks** — full CRUD, so registration can be scripted
- **Events** — receive verified webhook deliveries through one inbound route

## Register

Drop this in your project's `connectors/` directory — `createSixb()` auto-discovers it:

```ts
import { defineConnector } from "@sixb/core"
import { companycam } from "@sixb/connector-companycam"

export const companycamConnector = defineConnector(
  "companycam",
  companycam({
    token: process.env.COMPANYCAM_TOKEN!,
  })
)
```

| Option          | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `token`         | **Required.** CompanyCam Direct Access Token.                              |
| `baseUrl`       | API base URL. Defaults to `https://api.companycam.com/v2/`.                |
| `webhookSecret` | Shared secret — used as the webhook `token` and the inbound HMAC key.      |
| `onEvent`       | Handler for inbound webhook events. See [Webhooks](#webhooks).             |

The token comes from `app.companycam.com/access_tokens` and needs a paid plan.

## Client API

```ts
const cc = await sixb.connector(companycamConnector)
```

| Method                                | Endpoint                       |
| ------------------------------------- | ------------------------------ |
| `cc.projects.list(opts?)`             | `GET /projects`                |
| `cc.projects.get(id)`                 | `GET /projects/{id}`           |
| `cc.projects.listPhotos(id, opts?)`   | `GET /projects/{id}/photos`    |
| `cc.photos.list(opts?)`               | `GET /photos`                  |
| `cc.photos.get(id)`                   | `GET /photos/{id}`             |
| `cc.webhooks.create(input)`           | `POST /webhooks`               |
| `cc.webhooks.list(opts?)`             | `GET /webhooks`                |
| `cc.webhooks.get(id)`                 | `GET /webhooks/{id}`           |
| `cc.webhooks.update(id, input)`       | `PUT /webhooks/{id}`           |
| `cc.webhooks.delete(id)`              | `DELETE /webhooks/{id}`        |

```ts
const projects = await cc.projects.list({ query: "roof", perPage: 100 })
const photos = await cc.projects.listPhotos(projects[0].id, { startDate: 1_700_000_000 })
```

List methods return the raw array CompanyCam returns and take offset params
(`page` / `perPage`). There's no total count, so page until you get an **empty**
page:

```ts
const all: CompanyCamProject[] = []
for (let page = 1; ; page++) {
  const batch = await cc.projects.list({ page, perPage: 50 })
  if (batch.length === 0) break
  all.push(...batch)
}
```

Note: CompanyCam **caps `perPage` at 50** and may return fewer items than you
request, so a partial page is *not* a reliable end-of-list signal — stop on an
empty page, not a short one.

## Webhooks

### Receive events

Set `onEvent`. CompanyCam delivers every subscribed event to one route
(`/api/webhooks/<connector-id>/events`), so switch on `event.type`:

```ts
import type { CompanyCamProject } from "@sixb/connector-companycam"

companycam({
  token: process.env.COMPANYCAM_TOKEN!,
  webhookSecret: process.env.COMPANYCAM_WEBHOOK_SECRET,
  onEvent: async ({ event, sixb }) => {
    if (event.type === "project.created") {
      const project = event.payload as unknown as CompanyCamProject
      await sixb.upsertObject(Project.id, { id: project.id, name: project.name ?? "" })
    }
  },
})
```

`event` is `{ type, createdAt, webhookId, payload }`.

### Register a webhook (scriptable)

Unlike some platforms, CompanyCam manages webhooks via the API, so registration
can be automated — e.g. in a setup script:

```ts
await cc.webhooks.create({
  url: "https://<your-host>/api/webhooks/companycam/events",
  scopes: ["project.created", "photo.created"],
})
```

The `token` sent on `create` defaults to the connector's `webhookSecret`, so the
secret used to register matches the one used to verify inbound deliveries.

### The webhook secret

`webhookSecret` is a key **you generate** (e.g. `openssl rand -hex 32`) — CompanyCam
doesn't issue it. It's used in two places that must agree:

- sent as the webhook `token` when you `create` a subscription, and
- used to verify each delivery's `X-CompanyCam-Signature` (base64 HMAC-SHA1 of the
  raw body) before `onEvent` runs.

Leave it unset and verification is skipped (any request is accepted) — set it in
production.

## Notes

- **Timestamps** are Unix epoch **seconds** (`created_at`, `captured_at`, …), left
  as-is; convert in your handler.
- **IDs** are opaque strings.
- **Inbound deliveries respond with exactly `200`** — CompanyCam retries, and
  disables a hook after 25 errors.
- **No `photo_count` on projects** and **no `status` filter on `projects.list`**
  (`archived` is a separate boolean from the `active`/`deleted` `status`).
