# @sixb/connector-notion

Typed Notion Pages API connector for Sixb, authenticated with a static integration token.
Built on `@sixb/connector-rest`, with API version `2026-03-11` fixed by the connector.

## Setup

```bash
bun add @sixb/connector-notion
```

A workspace owner creates an **internal connection** in the
[Notion developer portal](https://app.notion.com/developers/connections), copies its installation
access token, and grants the required read/insert/update capabilities. Grant the connection access
to the target pages through **Content access** or the page's **Connections** menu. Access to a
parent page is inherited by its children. A valid token alone does not grant page access.

Store the token as `NOTION_TOKEN` in your environment, then define a project connector:

```ts
// connectors/notion.ts
import { defineConnector } from "@sixb/core"
import { notion } from "@sixb/connector-notion"

export const notionConnector = defineConnector(
  "notion",
  notion({ token: () => process.env.NOTION_TOKEN! })
)
```

Resolve the registered definition with `await runtime.connector(notionConnector)`. The token may
be a string or a synchronous/asynchronous resolver; the resolver runs for each HTTP attempt, so
secret rotation does not require rebuilding the client. Connection setup itself performs no API
request. A personal access token also uses Bearer authentication, but its permissions and lifetime
depend on its user. This package does not implement OAuth.

## Pages

Parameters use Notion's field names and UUID identifiers (with or without hyphens), not page URLs.
Methods return the original response, including partial page objects when returned by Notion.
Narrow with `"properties" in page` before reading full page fields.

```ts
const notion = await runtime.connector(notionConnector)

const page = await notion.pages.retrieve({ page_id: pageId })
const created = await notion.pages.create({
  parent: { page_id: parentPageId },
  properties: { title: { title: [{ text: { content: "Meeting notes" } }] } },
  markdown: "# Meeting notes\n\nDiscussed the roadmap.",
})

await notion.pages.update({
  page_id: created.id,
  properties: { title: { title: [{ text: { content: "Updated notes" } }] } },
})
await notion.pages.move({ page_id: created.id, parent: { page_id: otherParentId } })
await notion.pages.trash({ page_id: created.id })
await notion.pages.restore({ page_id: created.id })
```

| Method | HTTP endpoint |
| --- | --- |
| `pages.retrieve` | `GET /v1/pages/{page_id}` |
| `pages.create` | `POST /v1/pages` |
| `pages.update` | `PATCH /v1/pages/{page_id}` |
| `pages.move` | `POST /v1/pages/{page_id}/move` |
| `pages.trash` / `pages.restore` | `PATCH /v1/pages/{page_id}` with `in_trash` |
| `pages.properties.retrieve` | `GET /v1/pages/{page_id}/properties/{property_id}` |
| `pages.retrieveMarkdown` | `GET /v1/pages/{page_id}/markdown` |
| `pages.updateMarkdown` | `PATCH /v1/pages/{page_id}/markdown` |

Retrieve, create, and update accept `filter_properties` as query parameters. Create supports page
or data-source parents and typed properties; access and schema compatibility are checked by Notion.
Creating under a data source does not require a data-source client. Notion cannot permanently delete
pages through this API. Use `in_trash`; the legacy `archived` flag is rejected.

## Page properties and pagination

Retrieving a page returns metadata and properties, **not its body content**. Large properties can
be incomplete in that response. Retrieve a property separately and paginate using the opaque
`next_cursor`; do not parse it or follow `next_url` as an arbitrary URL.

```ts
let cursor: string | null | undefined
for (;;) {
  const property = await notion.pages.properties.retrieve({
    page_id: pageId,
    property_id: propertyId, // raw or already URL-encoded short property ID
    page_size: 100,
    start_cursor: cursor,
  })
  if (property.object !== "list") {
    console.log(property)
    break
  }
  console.log(property.results, property.property_item)
  if (!property.has_more) break
  cursor = property.next_cursor
}
```

Each call returns one scalar property or one list envelope. Rollup metadata is preserved, including
incomplete intermediate aggregates; do not treat the first page as the final aggregate.

## Markdown content

```ts
const content = await notion.pages.retrieveMarkdown({ page_id: pageId })
console.log(content.markdown, content.truncated, content.unknown_block_ids)

await notion.pages.updateMarkdown({
  page_id: pageId,
  type: "update_content",
  update_content: {
    content_updates: [{ old_str: "Discussed the roadmap.", new_str: "Approved the roadmap." }],
  },
})

await notion.pages.updateMarkdown({
  page_id: pageId,
  type: "replace_content",
  replace_content: { new_str: "# Meeting notes\n\nApproved the roadmap." },
})
```

The API uses Notion-flavored Markdown. `include_transcript: true` opts into meeting transcripts on
read. The client preserves `truncated` and `unknown_block_ids`: content is not guaranteed to be a
complete, lossless page export. Unknown IDs can be passed to `retrieveMarkdown` to request their
subtrees, but unsupported or inaccessible content can remain unavailable. No automatic recursive
fetch or destructive replacement is performed.

`update_content` and `replace_content` are recommended by Notion. The API's legacy `insert_content`
and `replace_content_range` commands are also typed. Notion protects child pages and databases
against deletion by default; the connector never turns on `allow_deleting_content` implicitly.
Create accepts Markdown or block content, not both; there is no separate Blocks resource in V1.

Writes are synchronous: `allow_async: true` is rejected. The official SDK 5.26.0 types expose that
option but do not represent the resulting `async_task` response. This client narrows the option to
`false` until async task support is added. Template application can still finish after page creation,
as documented by Notion.

## Reliability and errors

Every method accepts a second `{ signal }` argument, combined with the runtime's cancellation signal.

| Option | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `30000` | Timeout per HTTP attempt |
| `minDelayMs` | `350` | Minimum spacing of request starts per connected client |
| `maxRetries` | `2` | Additional HTTP attempts; `0` disables retries |
| `baseUrl` | `https://api.notion.com/v1/` | Alternative HTTP(S) API root for tests or a trusted proxy |

HTTP 429/529 responses honor `Retry-After` with bounded retries. Without that header, the shared
transport uses capped exponential backoff. GET requests also retry 500/502/503/504. Writes are
never automatically retried after other server errors, network failures, or timeouts because their
outcome may be unknown. Redirects are rejected. Pacing is local to one client, not a distributed
workspace quota; concurrent clients still need to handle provider rate limits.

```ts
import { NotionApiError } from "@sixb/connector-notion"

try {
  await notion.pages.retrieve({ page_id: pageId })
} catch (error) {
  if (error instanceof NotionApiError) {
    console.error(error.status, error.code, error.requestId, error.retryAfterMs)
  }
  throw error
}
```

`NotionApiError` retains response headers and the raw `responseBody`, including non-JSON errors.
Invalid successful envelopes raise a prefixed error. Unknown additive provider fields are preserved.
The official SDK supplies wire types only; HTTP execution stays in Sixb's REST transport.

V1 excludes search, database/data-source operations, comments, files, webhooks, and async task polling.

## References

- [Internal connections](https://developers.notion.com/guides/get-started/internal-connections)
- [Pages](https://developers.notion.com/reference/retrieve-a-page)
- [Page properties](https://developers.notion.com/reference/retrieve-a-page-property)
- [Markdown](https://developers.notion.com/guides/data-apis/working-with-markdown-content)
- [Request limits](https://developers.notion.com/reference/request-limits)

```bash
bun test connectors/notion/tests
bun --filter @sixb/connector-notion typecheck
bun --filter @sixb/connector-notion build
```
