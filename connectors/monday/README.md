# @sixb/connector-monday

Typed Monday GraphQL connector for Sixb. Supports boards, columns, groups, items, subitems,
updates (including replies), users and asset metadata. Built on `@sixb/connector-rest` and
pinned to API version `2026-07`.

## Setup

```sh
bun add @sixb/connector-monday
```

Use a personal API token for development or an app OAuth access token for an integration.
Tokens inherit user permissions; app tokens also need the relevant scopes: `boards:read`,
`boards:write`, `updates:read`, `updates:write`, `users:read`, and `assets:read` for the
resources you use. OAuth authorization and token storage/refresh belong to your application.

```ts
// connectors/monday.ts
import { defineConnector } from "@sixb/core"
import { monday } from "@sixb/connector-monday"

export const mondayConnector = defineConnector(
  "monday",
  monday({ token: () => process.env.MONDAY_TOKEN! })
)
```

Resolve it with `const api = await runtime.connector(mondayConnector)`. Connection is lazy.
The token resolver runs for every HTTP attempt and may be asynchronous. Tokens are sent in the
Authorization header; redirects are rejected. `endpoint` optionally specifies a trusted proxy's
full GraphQL URL. Never derive it from board content or an external file URL.

## Resources

| Resource | Methods |
| --- | --- |
| `boards` | `list`, `listAll`, `get`, `views` |
| `columns` | `list(boardId)`, `forItem(itemId)` |
| `groups` | `list(boardId)` |
| `items` | `get`, `list`, `nextPage`, `listAll`, `create`, `changeColumns`, `rename`, `moveToGroup` |
| `subitems` | `list(parentId)`, `listAll(parentId)`, `create` |
| `updates` | `list`, `listAll`, `create`, `edit` |
| `users` | `list`, `listAll`, `get` |
| `assets` | `get(assetId)`, `forItem(itemId)` |

IDs are decimal **strings**, not numbers or URLs. Group and column IDs retain Monday's string
identifiers. Fields use Monday's names. Results contain the selected fields described by exported
types, not every field in the platform schema. Missing item/user/asset lookups return `null`;
a missing board or collection's parent throws rather than masquerading as an empty collection.

```ts
for await (const board of api.boards.listAll({ workspace_ids: [workspaceId] })) {
  console.log(board.id, board.name, board.access_level)
}
const columns = await api.columns.list(boardId)
const groups = await api.groups.list(boardId)

for await (const item of api.items.listAll({
  board_id: boardId,
  limit: 50,
  column_ids: ["status", "date"],
  query_params: {
    rules: [{ column_id: "status", compare_value: "Approved", operator: "contains_terms" }],
  },
})) {
  console.log(item.id, item.column_values)
}
```

Use the actual board's column definitions to choose IDs, filter values and status labels.
`items.list` returns `{ cursor, items }`; pass its opaque cursor to `items.nextPage`.
`listAll` follows cursors until null, even through empty pages. Cursors expire 60 minutes after
the initial request: restart explicitly on expiry. Iteration is not a transactional snapshot;
concurrent edits can affect results. Board/user/update iterators use page numbers.
Users default to the platform's active and pending users.

Read requests accept a final `{ signal }` argument. For `items.get` and `subitems.list/listAll`,
column selection is the second argument and request options are third. Omit `column_ids` to
read all values; pass `[]` to omit them. Raw `value` and `settings` JSON is preserved as returned,
including JSON-encoded strings. Display `text` is nullable and is not a universal write format.

## Subitems and schema differences

`subitems.list` reads all immediate children returned by Monday, without a client-side cap.
The underlying `subitems` field has no pagination arguments. `subitems.listAll` traverses all
descendants, querying each visited item; use `list` for a classic one-level board to avoid the
extra leaf queries. Large hierarchies can consume significant complexity and request quota.

Classic subitems can live on a separate physical board. Use `columns.forItem(subitem.id)` to
get that board's ID and schema, and pass its ID when writing. Do not reuse the parent board's
column IDs or status indexes. Multi-level boards can share a schema and have deeper hierarchies.
Creating their first subitem can clear parent values and activate rollups according to
[Monday's subitem rules](https://developer.monday.com/api-reference/reference/subitems).

## Targeted writes

```ts
const created = await api.items.create({
  board_id: boardId,
  group_id: groupId,
  item_name: "October content",
})

const child = await api.subitems.create({
  parent_item_id: created.id,
  item_name: "Product video",
})
const schema = await api.columns.forItem(child.id)

await api.items.changeColumns({
  board_id: schema.board_id,
  item_id: child.id,
  column_values: {
    status: { label: "Approved" },
    date0: { date: "2026-10-01" },
    caption: { text: "Publication copy" },
    content_link: { url: "https://example.com/video", text: "Video" },
  },
}, { idempotencyKey: operationId })

await api.items.rename({ board_id: boardId, item_id: created.id, name: "October campaign" })
await api.items.moveToGroup({ item_id: created.id, group_id: completedGroupId })
```

Example column IDs are placeholders. Only supplied columns change. Supported write types cover
text, long text, status, date, link, people and timeline; TypeScript cannot infer a live board's
schema, so Monday validates the column/type pairing. Values are JSON-serialized once by the
connector. Status labels are never created implicitly. Use the type-specific clearing format
(`null`, empty string or empty object), not a universal empty value. For example, `null` clears
a people column. A people write replaces the entire assignment list.

## Updates and assets

```ts
for await (const update of api.updates.listAll({ item_id: itemId })) {
  console.log(update.text_body, update.replies)
}
await api.updates.create({ item_id: itemId, body: "<p>Ready for review.</p>" })
await api.updates.edit({ id: updateId, body: "<p>Revised copy.</p>" })
const files = await api.assets.forItem(itemId)
```

Updates contain HTML `body`, plain `text_body` and replies. Sanitize HTML before rendering it.
Editing updates is subject to Monday's author/permission restrictions. This version reads replies
but does not create or edit them.

Assets return metadata and temporary URLs; the connector does not download or upload files.
External links stored in file/link columns are not necessarily Monday assets. Access to Drive,
Canva or Google Docs requires those services' own integrations and permissions.
`boards.views` returns names, IDs and types only, not custom app content or rendered views.

## Failures, retries and cancellation

`MondayApiError` exposes HTTP status, provider body, GraphQL errors, partial data, request ID,
response headers and `retryAfterMs`. An HTTP 200 with GraphQL errors throws. Partial results are
never silently reported as complete, and a failed mutation may already have changed some data.

Defaults: 30-second per-attempt timeout, 100-ms request pacing, and at most two read retries.
Reads retry selected transient HTTP/GraphQL rejections, respecting both Retry-After and
retry_in_seconds. Authentication, validation, daily quota, partial-result, network and timeout
errors are surfaced without automatic replay. Delays beyond the platform timer range are surfaced.
Pacing is per connection, not a shared account-wide quota coordinator.

Mutations are **never automatically retried**. Optional `idempotencyKey` on write calls forwards
Monday's `Idempotency-Key` header for an application-controlled retry of the same operation.
Reuse the same key and payload; do not generate a fresh key for a retry. Monday's cache lasts
30 minutes and has size/budget limits, so this is not an exactly-once guarantee.
See [idempotency](https://developer.monday.com/api-reference/docs/idempotency) and
[rate limits](https://developer.monday.com/api-reference/docs/rate-limits).

The runtime's cancellation signal and per-request signal apply to requests, pacing and backoff.
The connector does not log secrets or content. Caller code owns retries after surfaced errors
and any concurrent-edit conflict policy.

## Scope

Client-to-board mappings and editorial conventions belong to your application. This package does
not create boards or columns, delete/archive records, manage views, register webhooks, or implement
OAuth flows. It does not assume every board is a client or that every board has the same columns.

The fixed queries and mutations follow the official references for
[boards](https://developer.monday.com/api-reference/reference/boards),
[columns](https://developer.monday.com/api-reference/reference/columns),
[items](https://developer.monday.com/api-reference/reference/items),
[updates](https://developer.monday.com/api-reference/reference/updates),
[users](https://developer.monday.com/api-reference/reference/users), and
[assets](https://developer.monday.com/api-reference/reference/assets-1).
