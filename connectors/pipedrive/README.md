# @sixb/connector-pipedrive

Read-first Pipedrive connector for Sixb.

This connector covers high-payback CRM sync surface:

- Deals, persons, organizations, products
- Activities
- Pipelines, stages, and field definitions
- Leads
- Notes
- File metadata
- Users
- Item search
- Inbound Pipedrive general webhook v2 deliveries

The connector uses personal API tokens only. OAuth, most writes, Projects/Tasks, file upload/download,
and webhook management API calls are intentionally deferred. Person create/update writes are supported
for CRM contact writeback flows.

## Register

Drop this in your project's `connectors/` directory. `createSixb()` auto-discovers it:

```ts
import { defineConnector } from "@sixb/core"
import { pipedrive } from "@sixb/connector-pipedrive"

export const pipedriveConnector = defineConnector(
  "pipedrive",
  pipedrive({
    apiToken: process.env.PIPEDRIVE_API_TOKEN!,
  })
)
```

| Option | Description |
| --- | --- |
| `apiToken` | Required. Personal Pipedrive API token, or a resolver returning one. Sent as `x-api-token`. |
| `v2BaseUrl` | API v2 base URL. Defaults to `https://api.pipedrive.com/api/v2/`. |
| `v1BaseUrl` | API v1 base URL. Defaults to `https://api.pipedrive.com/v1/`. |
| `timeoutMs` | Optional per-request timeout passed to `@sixb/connector-rest`. |
| `minDelayMs` | Optional minimum delay between outbound requests. |
| `retry` | Optional REST retry policy. Defaults to two retries for retryable responses. |
| `webhookAuth` | Optional HTTP basic auth credentials for inbound webhook verification. |
| `onEvent` | Optional handler for inbound Pipedrive general webhook v2 deliveries. |

## Client API

```ts
const pd = await sixb.connector(pipedriveConnector)
```

| Method | Endpoint |
| --- | --- |
| `pd.activities.list(opts?)` | `GET /api/v2/activities` |
| `pd.activities.listAll(opts?)` | cursor iterator over `GET /api/v2/activities` |
| `pd.activities.get(id)` | `GET /api/v2/activities/{id}` |
| `pd.deals.list(opts?)` | `GET /api/v2/deals` |
| `pd.deals.listAll(opts?)` | cursor iterator over `GET /api/v2/deals` |
| `pd.deals.listArchived(opts?)` | `GET /api/v2/deals/archived` |
| `pd.deals.listAllArchived(opts?)` | cursor iterator over `GET /api/v2/deals/archived` |
| `pd.deals.get(id, opts?)` | `GET /api/v2/deals/{id}` |
| `pd.deals.search(opts)` | `GET /api/v2/deals/search` |
| `pd.persons.list(opts?)` / `listAll` / `create` / `get` / `update` / `search` | `/api/v2/persons*` |
| `pd.organizations.list(opts?)` / `get` / `search` | `GET /api/v2/organizations*` |
| `pd.products.list(opts?)` / `get` / `search` | `GET /api/v2/products*` |
| `pd.pipelines.list(opts?)` / `get` | `GET /api/v2/pipelines*` |
| `pd.stages.list(opts?)` / `get` | `GET /api/v2/stages*` |
| `pd.*Fields.list(opts?)` / `get(fieldCode)` | `GET /api/v2/*Fields*` |
| `pd.itemSearch.search(opts)` | `GET /api/v2/itemSearch` |
| `pd.itemSearch.searchByField(opts)` | `GET /api/v2/itemSearch/field` |
| `pd.leads.list(opts?)` | `GET /v1/leads` |
| `pd.leads.listAll(opts?)` | offset iterator over `GET /v1/leads` |
| `pd.leads.listArchived(opts?)` | `GET /v1/leads/archived` |
| `pd.leads.get(id)` | `GET /v1/leads/{id}` |
| `pd.leads.search(opts)` | `GET /v1/leads/search` |
| `pd.leads.permittedUsers(id)` | `GET /v1/leads/{id}/permittedUsers` |
| `pd.notes.list(opts?)` / `get` | `GET /v1/notes*` |
| `pd.notes.listComments(id, opts?)` / `getComment` | `GET /v1/notes/{id}/comments*` |
| `pd.files.list(opts?)` / `get` | `GET /v1/files*` |
| `pd.users.list(opts?)` / `me` / `get` / `find` | `GET /v1/users*` |

Example sync read:

```ts
for await (const deal of pd.deals.listAll({ updated_since: "2026-01-01T00:00:00Z" })) {
  // map to a dataset or Sixb object
}
```

## Pagination

Pipedrive v2 list endpoints use cursor pagination. `listAll(...)` follows
`additional_data.next_cursor` until Pipedrive returns `null` or omits it.

Pipedrive v1 list endpoints in this connector use offset pagination. `listAll(...)` follows
`additional_data.pagination.next_start` while `more_items_in_collection` is true.

## Custom fields

Pipedrive custom fields are account-specific. v2 commonly nests them in `custom_fields`; v1 may
return account-specific keys directly. The connector types include common fields and preserve
unknown Pipedrive fields rather than normalizing them.

## Webhooks

Create a Pipedrive general webhook v2 in the Pipedrive app and point it to:

```txt
https://<sixb-host>/api/webhooks/pipedrive/events
```

Configure `onEvent` to receive deliveries:

```ts
pipedrive({
  apiToken: process.env.PIPEDRIVE_API_TOKEN!,
  webhookAuth: {
    username: process.env.PIPEDRIVE_WEBHOOK_USER!,
    password: process.env.PIPEDRIVE_WEBHOOK_PASSWORD!,
  },
  onEvent: async ({ event, sixb, client }) => {
    if (event.meta.action === "change" && event.meta.entity === "deal") {
      const pd = await client()
      const deal = await pd.deals.get(Number(event.meta.entity_id))
      // upsert deal into Sixb
    }
  },
})
```

When `webhookAuth` is set, deliveries must use matching HTTP basic auth. Without it, the connector
only validates the JSON envelope shape.

## Errors

Non-2xx Pipedrive responses throw `PipedriveApiError`.

```ts
import { PipedriveApiError } from "@sixb/connector-pipedrive"

try {
  await pd.deals.get(123)
} catch (error) {
  if (error instanceof PipedriveApiError) {
    console.log(error.status, error.responseBody)
  }
}
```

## Not covered yet

- OAuth
- Most creates, updates, and deletes beyond Pipedrive persons
- Projects, project boards, project phases, project templates, project fields, and tasks
- File upload, remote file linking, file updates/deletes, and file download
- Webhook management API calls
- Billing, goals, roles, permission sets, mailbox, channels, meetings, and analytics endpoints

