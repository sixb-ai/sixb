# @sixb/connector-meta

A Meta connector for Sixb, built on `@sixb/connector-rest`. It is a thin,
read-only, one-to-one client over the Graph API for Facebook Pages and Instagram
Business/Creator accounts — one method per node/edge, nothing more.

- **Pages** — list Facebook Pages and their linked Instagram accounts (`/me/accounts`)
- **Instagram** — read the user profile, list media and stories, read account- and media-level insights
- **Facebook** — read the Page profile, list published Page posts, read Page-level insights
- **Batch** — combine up to 50 independent Graph reads, with an optional token per sub-request

The connector stays metric-agnostic and returns Graph responses faithfully: it does
not flatten attachments, coerce timestamps, reorder insights, or bake in a metric
taxonomy. Account selection, metric choice, and row shaping are the project's job.

## Register

Drop this in your project's `connectors/` directory — `createSixb()` auto-discovers it:

```ts
import { defineConnector } from "@sixb/core"
import { meta } from "@sixb/connector-meta"

export const metaConnector = defineConnector(
  "meta",
  meta({
    accessToken: process.env.META_GRAPH_ACCESS_TOKEN!,
  })
)
```

| Option         | Description                                                                       |
| -------------- | --------------------------------------------------------------------------------- |
| `accessToken`  | **Required.** Long-lived User or System-User access token.                        |
| `graphVersion` | Graph API version segment. Defaults to `v23.0`.                                   |
| `baseUrl`      | Full base URL override (takes precedence over `graphVersion`). Mainly for tests.  |
| `retry`        | Retry policy for transient HTTP and Meta throttling errors. Defaults to 2 retries. |
| `maxRetries`   | Deprecated shorthand for `retry.maxRetries`.                                      |
| `onResponse`   | Observe response headers and parsed quota usage without wrapping returned objects. |
| `timeoutMs`    | Per-request timeout in milliseconds.                                              |

**Tokens.** The `accessToken` authorizes Page discovery (`/me/accounts`) and Instagram
reads. `/me/accounts` returns a per-Page access token on each Page — pass it to
`client.facebook(id, { accessToken })` for Page-level reads. The connector does not
refresh tokens; supply a valid long-lived token.

## Client API

```ts
const meta = await sixb.connector(metaConnector)
```

The client mirrors the Graph API graph:

| API                                                  | Graph endpoint                       |
| ---------------------------------------------------- | ------------------------------------ |
| `meta.pages.list()` / `.listAll()`                   | `GET /me/accounts`                   |
| `meta.instagram(id).get()`                           | `GET /{ig-user-id}`                  |
| `meta.instagram(id).media.list()` / `.listAll()`     | `GET /{ig-user-id}/media`            |
| `meta.instagram(id).stories.list()` / `.listAll()`   | `GET /{ig-user-id}/stories`          |
| `meta.instagram(id).insights.get()`                  | `GET /{ig-user-id}/insights`         |
| `meta.instagramMedia(id).insights.get()`             | `GET /{ig-media-id}/insights`        |
| `meta.facebook(id, { accessToken }).get()`           | `GET /{page-id}`                     |
| `meta.facebook(id, { accessToken }).posts.list()` / `.listAll()` | `GET /{page-id}/published_posts` |
| `meta.facebook(id, { accessToken }).insights.get()`  | `GET /{page-id}/insights`            |
| `meta.batch.get()` / `.execute()`                    | Graph API Batch endpoint              |

> **Why `pages`, not `accounts`?** Meta's `/me/accounts` edge is a historical name —
> it returns the Facebook **Pages** the token manages (`MetaFacebookPage`), each with
> its linked `instagram_business_account`. It's named `pages` here to describe what it
> returns and to avoid confusion with Instagram accounts (`meta.instagram(id)`).

```ts
// Pages and their linked Instagram accounts.
for await (const page of meta.pages.listAll()) {
  const ig = page.instagram_business_account
  if (ig) {
    // Instagram media, with insights expanded inline.
    for await (const media of meta.instagram(ig.id).media.listAll({
      metrics: ["views", "total_interactions"],
    })) {
      // media.insights is populated by the inline expansion
    }
  }

  // Facebook posts, scoped with the Page access token from /me/accounts.
  const fb = meta.facebook(page.id, { accessToken: page.access_token })
  for await (const post of fb.posts.listAll({ since: new Date("2026-01-01") })) {
    // post.attachments is the full array; post.created_time is the raw API string
  }
}

// Account-level insights — the caller owns metric selection and metric_type.
const insights = await meta.instagram("17841400000000000").insights.get({
  metrics: ["views", "total_interactions"],
  period: "day",
  metricType: "total_value",
  since: new Date("2026-01-01"),
  until: new Date("2026-01-08"),
})
```

### Fields

Every list and `get` method takes an optional `fields` array. It defaults to a sensible
selection exported for reuse — `DEFAULT_PAGE_FIELDS`, `DEFAULT_INSTAGRAM_USER_FIELDS`,
`DEFAULT_INSTAGRAM_MEDIA_FIELDS`, `DEFAULT_INSTAGRAM_STORY_FIELDS`,
`DEFAULT_FACEBOOK_PAGE_FIELDS`, `DEFAULT_FACEBOOK_POST_FIELDS`. Pass `metrics` to
`media.list`, `stories.list`, or `posts.list` to expand insights inline via
`insights.metric(...)` (the only way to capture story insights while a story is live).

### Pagination

List methods return a **single page** envelope. Pass `nextCursor` back as `after` to
fetch the next page, or use `listAll()` to follow `paging.next` to exhaustion:

```ts
let after: string | undefined
do {
  const page = await meta.instagram(igUserId).media.list({ limit: 100, after })
  // handle page.items
  after = page.hasMore ? page.nextCursor : undefined
} while (after)
```

Instagram's `/media` edge supports cursor pagination, not time-based pagination. Meta's
[official Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
documents the User Insights edge as the only Instagram edge with time-based pagination for
Facebook Login. The connector therefore does not send undocumented `since` or `until` parameters
to `/media`.

### Batch reads

The Graph Batch endpoint uses an outer `POST`, but this connector only constructs `GET`
sub-requests. Each result is independent and keeps its status, raw body, headers, parsed body,
quota usage, and structured Graph error when present:

```ts
type MediaEnvelope = { readonly data: readonly MetaInstagramMedia[] }

const [page, media] = await meta.batch.execute([
  meta.batch.get<MetaFacebookPageProfile>(`${pageId}?fields=id,name`, {
    accessToken: pageAccessToken,
  }),
  meta.batch.get<MediaEnvelope>(`${igUserId}/media?fields=id,timestamp&limit=100`),
] as const)

if (media.ok) {
  // media.body.data is typed; media.rawBody preserves Meta's original response body.
} else {
  // media.error is the structured Graph error for this sub-request only.
}
```

Absolute URLs, empty batches, and batches above Meta's 50-request limit are rejected locally.
Batching reduces network round trips, but every sub-request still counts separately toward Meta's
usage limits. Throttled sub-requests are retried without replaying successful siblings.

## Insights & metric deprecations

The connector is **metric-agnostic**: it passes `metrics`, `period`, `metricType`,
`since`, `until`, and `breakdown` straight through. Meta requires some metrics to be
requested with `metricType: "total_value"` and forbids mixing incompatible metrics in
one call — partitioning metrics by type is the **caller's** responsibility, because
Meta's valid metric set changes frequently. Notable recent changes:

- **Instagram** (Jan 2025): `profile_views`, `website_clicks`, `email_contacts`, and
  non-Reels `video_views` were deprecated. `impressions` is replaced by `views`.
- **Facebook Pages** (Nov 2025): `page_impressions` → `page_media_view`; `page_fans` →
  `page_follows`; `post_impressions` → `post_media_view`. A broader set of legacy Page
  metrics was deprecated across **all** API versions in June 2026 — calling them returns
  an invalid-metric error.

Validate metric names against the live Graph API for your `graphVersion`.

## Throttling and usage

In addition to network failures, HTTP `429`, and `5xx`, the default policy retries Graph throttling
codes `4`, `17`, `32`, and `613`, including when Meta returns them with HTTP `400`. Retries remain
bounded by `retry.maxRetries`; customize `shouldRetry` or `delayMs` when a project needs a different
backoff policy.

`MetaApiError` exposes the parsed Graph error and body, `rawBody`, response headers, and parsed usage.
Successful responses can be observed through `onResponse`, including `X-App-Usage` and
`X-Business-Use-Case-Usage`:

```ts
meta({
  accessToken,
  onResponse({ path, usage }) {
    console.log(path, usage.app, usage.businessUseCase)
  },
})
```

The connector reports quota signals but does not choose account pacing, persistence, or circuit
breaker policy for the project.

## Notes

- **Read-only.** Every Graph operation is a read. Batch execution uses Meta's required outer
  `POST`, but the connector only accepts `GET` sub-requests.
- **Faithful responses.** Attachments are returned as a full array, timestamps as raw
  API strings, and insights in API order. Flatten or normalize in your project layer.
- **No account orchestration.** Deduping Pages/accounts and filtering to a specific
  Page or Instagram account is project policy — build it on top of `pages.listAll()`.
- **No media time window.** Meta does not officially support time-based pagination on the
  Instagram `/media` edge; filter cursor-paginated results in the project layer.
- **Webhooks** are out of scope (this is a sync/read use case). They can be added later
  via `defineWebhook` from `@sixb/core`.
