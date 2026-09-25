# @sixb/connector-meta

A Meta connector for Sixb, built on `@sixb/connector-rest`. It is a thin,
typed, one-to-one client over the Graph API for Facebook Pages and Instagram
Business/Creator accounts — one method per node/edge, nothing more.

- **Pages** — list Facebook Pages and their linked Instagram accounts (`/me/accounts`)
- **Instagram** — read the user profile, list media and stories, read account- and media-level insights
- **Facebook** — read the Page profile, list published Page posts, read Page-level insights
- **Batch** — combine up to 50 independent Graph reads, with an optional token per sub-request
- **Publishing** — Instagram images, Reels and carousels; Facebook photos, multi-photo posts,
  videos and Reels, with explicit upload and status operations

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
refresh tokens; supply a valid long-lived token. Instagram user, media and container scopes and
`facebookVideo()` also accept `{ accessToken }`. Publishing requires the appropriate write
permissions, not just a token that can read the account.

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

The connector currently exposes only cursor pagination for Instagram `/media`. Its
[endpoint reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media/)
documents `since`/`until`, while Meta's general guide limits time-based pagination to insights.
Time-window inputs are not exposed by this package.

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

## Publishing

Publishing uses Facebook Login: Instagram must be a professional account linked to a Page.
Request `instagram_basic`, `instagram_content_publish` and `pages_read_engagement` for Instagram;
`pages_manage_posts` and `pages_read_engagement` for Facebook; `pages_show_list` for discovery.
Business Manager assignments may require additional permissions. The token owner needs the
appropriate content-creation task. Request `fields: ["id", "tasks"]` on `pages.list()` to inspect
Page tasks. External customer accounts may require Advanced Access, App Review and Business
Verification. Page Publishing Authorization and two-factor requirements can also block publishing.

New publishing inputs use Meta's field names. Responses retain distinct container, media, photo,
video and post IDs. No method waits for processing or automatically publishes an uploaded asset.

### Instagram

```ts
const ig = meta.instagram(igUserId, { accessToken: pageAccessToken })
const container = await ig.media.create({
  image_url: "https://cdn.example.com/photo.jpg",
  caption: "Our latest collection",
  alt_text: "A linen jacket",
})
const status = await meta.instagramContainer(container.id, {
  accessToken: pageAccessToken,
}).get()
if (status.status_code === "FINISHED") {
  const published = await ig.media.publish({ creation_id: container.id })
  // Persist published.id separately from container.id.
}
```

- **Reel:** `media.create({ media_type: "REELS", video_url, caption, share_to_feed })`.
- **Carousel:** create image/video containers with `is_carousel_item: true` (video children use
  `media_type: "VIDEO"`), then create `{ media_type: "CAROUSEL", children: [id1, id2], caption }`.
  Publish the parent. A carousel has 2–10 children; captions belong to the parent.
- **Binary video:** create with `upload_type: "resumable"` instead of `video_url`, then call
  `instagramContainer(id, { accessToken }).upload(uri, { file: Bun.file(path) })` using the returned
  `uri`. The transfer also accepts `{ file_url }`.
- **Status:** `instagramContainer(id).get()` returns `status_code` and `status`.
  `IN_PROGRESS` is pending, `FINISHED` is ready, `PUBLISHED` is already published;
  `ERROR` and `EXPIRED` need application handling. Meta recommends checking once per minute,
  for at most five minutes. Persist the ID so processing can be checked later.
- **Quota:** `ig.contentPublishingLimit.get()` returns the native `data` envelope with
  `quota_usage` and `config`. Use the returned limit: Meta's documentation disagrees on 50 vs 100.
- **Published media:** `instagramMedia(id, { accessToken }).get()` includes the permalink.

Containers expire after 24 hours; creation is separately limited to 400 containers per rolling day.
Create containers near the intended publish time. Instagram scheduling is application-owned.

### Facebook

```ts
const page = meta.facebook(pageId, { accessToken: pageAccessToken })
const first = await page.photos.create({ url: firstPhotoUrl, published: false })
const second = await page.photos.create({ url: secondPhotoUrl, published: false })
const post = await page.posts.create({
  message: "Our latest collection",
  attached_media: [{ media_fbid: first.id }, { media_fbid: second.id }],
})
```

Single photos can be published directly with `photos.create({ url, caption, alt_text_custom })`.
Use `source: Blob` instead of `url` for multipart uploads. An unpublished photo response may
omit `post_id`.

Videos use `videos.create({ file_url, title, description })` or `{ source: Blob, ... }`.
These direct uploads are distinct from Reels and do not expose Facebook's chunked video or
app-scoped upload-handle protocols.

```ts
const session = await page.reels.start()
await page.reels.upload(session, { file_url: videoUrl })
await page.reels.finish({
  video_id: session.video_id,
  video_state: "PUBLISHED",
  description: "Behind the scenes",
})
const video = await meta.facebookVideo(session.video_id, {
  accessToken: pageAccessToken,
}).get()
// Inspect video.status.publishing_phase; success:true alone is not visibility confirmation.
```

Reel transfers accept `{ file: Blob, offset?: number }` as well. Pass the complete original file;
the connector sends its suffix from `offset`. For Facebook resume, use the server's
`status.uploading_phase.bytes_transfered`. Transfer calls use the returned Meta upload URL,
OAuth headers, and reject redirects.

Facebook supports native scheduling: photos/posts/videos require `published: false` with
`scheduled_publish_time` (Unix seconds); Reels require `video_state: "SCHEDULED"`.
Allowed time windows vary by endpoint and are enforced by Meta. For scheduled multi-photo posts,
upload photos with `published: false, temporary: true` and pass
`unpublished_content_type: "SCHEDULED"` to `posts.create()`.

### Media and recovery

Hosted media must remain accessible to Meta without authentication headers until processing
finishes. Facebook hosted Reels reject Meta CDN URLs and hosts that block its crawler.
Instagram feed images require JPEG (up to 8 MB, ratio 4:5–1.91:1); its media reference currently
limits Reels to 300 MB and 3 seconds–15 minutes. Facebook photos allow up to 10 MB, and its Reels
guide specifies 3–90 seconds. Codec and format details are in the references below. The connector
validates request structure, not remote file contents; conversion and media inspection belong
in the application.

**Writes are never automatically retried**, including by custom retry policies. A timeout may
mean the write succeeded remotely. Save intermediate IDs and inspect status before retrying;
without an ID the outcome may remain unknown. Instagram and Facebook are independent publications.
In particular, Graph `4/2207051` is an anti-spam restriction, not ordinary quota exhaustion.
Upload failures and malformed acknowledgements retain their body in `MetaApiError`, even on
HTTP 200. There is no universal exactly-once publication guarantee.

This API covers images, Reels, carousels and Page videos; Stories, product tags, partnership labels,
editing/deletion and cross-platform orchestration are not included. Existing reads remain on the
default Graph version; choose `graphVersion` explicitly for your integration and verify publishing
with designated test accounts before production.

Official references: [Instagram publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing/),
[Instagram media inputs](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media/),
[Facebook photos](https://developers.facebook.com/docs/graph-api/reference/page/photos/),
[Page videos](https://developers.facebook.com/docs/graph-api/reference/page/videos/),
[Facebook Reels](https://developers.facebook.com/documentation/video-api/guides/reels-publishing/).
Some older examples disagree with the endpoint references on limits; quota/config responses
and the selected API version take precedence.

## Throttling and usage

For reads, in addition to network failures, HTTP `429`, and `5xx`, the default policy retries Graph throttling
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
An `onResponse` exception for an HTTP response emits a prefixed warning and does not discard
the response, so telemetry failures cannot hide a successful publication.

## Notes

- **Read-only batch.** Batch execution uses Meta's required outer `POST`, but only accepts
  `GET` sub-requests. Publishing uses separate operations with no automatic replay.
- **Faithful responses.** Attachments are returned as a full array, timestamps as raw
  API strings, and insights in API order. Flatten or normalize in your project layer.
- **No account orchestration.** Deduping Pages/accounts and filtering to a specific
  Page or Instagram account is project policy — build it on top of `pages.listAll()`.
- **Media time windows.** The connector currently exposes cursor pagination on Instagram
  `/media`. Its current endpoint reference documents `since`/`until`, while the general guide
  disagrees; time-window inputs are not exposed by this package.
- **Webhooks** are not exposed by this connector. They can be added later
  via `defineWebhook` from `@sixb/core`.
