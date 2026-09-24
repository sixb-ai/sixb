# @sixb/connector-tiktok

Connector for TikTok Display API, Business Account organic data and publishing, and Ads reporting.
Each API has its own OAuth grant and app credentials, so register one connector definition per API.

## Register

```ts
import { defineConnector } from "@sixb/core"
import { tiktok } from "@sixb/connector-tiktok"

export const tiktokDisplay = defineConnector(
  "tiktok-display",
  tiktok({
    api: "display",
    clientKey: process.env.TIKTOK_CLIENT_KEY!,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET!,
    scopes: ["user.info.basic", "user.info.profile", "user.info.stats", "video.list"],
  })
)

export const tiktokOrganic = defineConnector(
  "tiktok-organic",
  tiktok({
    api: "organic",
    clientId: process.env.TIKTOK_CLIENT_ID!,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET!,
    authorizationUrl: process.env.TIKTOK_ACCOUNT_AUTHORIZATION_URL!,
  })
)

export const tiktokAds = defineConnector(
  "tiktok-ads",
  tiktok({
    api: "marketing",
    appId: process.env.TIKTOK_APP_ID!,
    secret: process.env.TIKTOK_APP_SECRET!,
  })
)
```

| `api` | TikTok product | Credentials | Data |
| --- | --- | --- | --- |
| `display` | Login Kit + Display API | Client key / secret | Authorized user profile, public videos, public counters |
| `organic` | Business Accounts API | Client ID / secret + portal authorization URL | Business profile insights, posts, comments, photo/video publishing |
| `marketing` | Marketing API | App ID / secret | Advertisers, campaigns, ad groups, ads, reports |

Display defaults to `user.info.basic` and `video.list`. Request `user.info.profile` and
`user.info.stats` only after TikTok approves those scopes for the app. Display exposes video
`comment_count`, but not comment contents.

For Business Organic, copy the complete account-holder authorization URL from the TikTok app
portal. Register Sixb's callback URL with a trailing slash; this flow requires an exact HTTPS
redirect URI ending in `/`. Marketing uses a long-lived, non-refreshable access token.

All three adapters set `pkce: "disabled"` for their documented server-side flows and send no PKCE
parameters. Sixb's one-use state, callback browser binding, and redirect validation remain enforced.

## Client API

Display account:

| Client method | Endpoint |
| --- | --- |
| `client.profile.get(...)` | `GET /v2/user/info/` |
| `client.videos.list(...)` / `.listAll(...)` | `POST /v2/video/list/` |
| `client.videos.query(...)` | `POST /v2/video/query/` |

Business Organic account:

| Client method | Endpoint |
| --- | --- |
| `client.profile.get(...)` | `GET /business/get/` |
| `client.posts.list(...)` / `.listAll(...)` | `GET /business/video/list/` |
| `client.comments.list(...)` / `.listAll(...)` | `GET /business/comment/list/` |
| `client.comments.replies.list(...)` / `.listAll(...)` | `GET /business/comment/reply/list/` |
| `client.publishing.getSettings()` | `GET /business/video/settings/` |
| `client.publishing.publishVideo(...)` | `POST /business/video/publish/` |
| `client.publishing.publishPhotos(...)` | `POST /business/photo/publish/` |
| `client.publishing.getStatus(shareId)` | `GET /business/publish/status/` |

Ads account:

| Client method | Endpoint |
| --- | --- |
| `client.adAccount.get(...)` | `GET /advertiser/info/` |
| `client.campaigns.list(...)` / `.listAll(...)` | `GET /campaign/get/` |
| `client.adGroups.list(...)` / `.listAll(...)` | `GET /adgroup/get/` |
| `client.ads.list(...)` / `.listAll(...)` | `GET /ad/get/` |
| `client.reports.run(...)` / `.runAll(...)` | `GET /report/integrated/get/` |

Every resource is scoped to the account selected during the Sixb connection flow. Wire objects
retain TikTok's field names and values; list helpers only normalize pagination envelopes.

```ts
for await (const video of display.videos.listAll({
  fields: ["id", "create_time", "view_count", "like_count", "comment_count", "share_count"],
  maxCount: 20,
})) {
  // persist or transform the TikTok wire object
}

for await (const post of businessOrganic.posts.listAll({
  fields: ["item_id", "caption", "create_time", "video_views", "likes"],
  maxCount: 20,
})) {
  // persist or transform the TikTok wire object
}

for await (const row of ads.reports.runAll({
  serviceType: "AUCTION",
  reportType: "BASIC",
  dataLevel: "AUCTION_AD",
  dimensions: ["ad_id", "stat_time_day"],
  metrics: ["spend", "impressions", "clicks"],
  startDate: "2026-08-01",
  endDate: "2026-08-25",
  pageSize: 1000,
})) {
  // TikTok report metrics remain strings
}
```

## Publish photos and videos

Publishing is available only on `api: "organic"`, using the existing Business account OAuth
grant. Enable Video Publish / Photo Publish permissions in the TikTok Business app and have the
account owner authorize them through the portal authorization URL. Existing connections need
reauthorization if these permissions were not granted. Display/Login Kit and Ads tokens are not
interchangeable with this grant. Drafts additionally require `video.upload`.

```ts
const settings = await businessOrganic.publishing.getSettings()
// Render only settings.privacy_level_options and respect comment/duet/stitch restrictions.
// Obtain the user's choices and consent before calling publishPhotos/publishVideo.
const task = await businessOrganic.publishing.publishPhotos({
  photo_images: ["https://media.example.com/collection/front.jpg"],
  photo_cover_index: 0,
  post_info: {
    title: "Our new collection",
    caption: "Discover the details",
    privacy_level: "PUBLIC_TO_EVERYONE", // User-selected; must be allowed by settings.
    disable_comment: settings.comment_disabled,
    is_brand_organic: true, // Promotes our own business; an explicit user choice.
    is_branded_content: false,
  },
})
// Persist task.share_id before polling. It identifies the task, not the published post.
const status = await businessOrganic.publishing.getStatus(task.share_id)
```

Video input uses `video_url`, optional `custom_thumbnail_url`, and `post_info` containing explicit
`is_brand_organic` / `is_branded_content` booleans, plus optional `caption`, `disable_comment`,
`disable_duet`, `disable_stitch`, `thumbnail_offset` (milliseconds), and `is_ai_generated`.
Unlike photos, the Business video endpoint publishes publicly and has no `privacy_level` field.
Sixb requires explicit commercial disclosures for direct posts, following TikTok's field table
even though its older examples omit them.

For a video draft, set `post_info: { upload_to_draft: true }`. For a photo draft, use
`post_info: { is_draft: true, title: "Draft", caption: "Editable caption" }`. TikTok ignores other
post metadata in these modes, so Sixb rejects it instead of silently dropping user choices.
`SEND_TO_USER_INBOX` means the creator must finish publishing inside TikTok, not that the post is live.

### Media and delivery constraints

- Supply publicly accessible HTTP(S) URLs on a domain/prefix verified in the TikTok Business app.
  Keep video URLs valid for at least 30 minutes and all media accessible until transfer completes.
  Sixb validates URL syntax, not domain ownership, reachability or file contents; prepare and
  validate media in the application before submitting. It does not download or transcode files.
- Videos: MP4/MOV/WebM, at most 1 GB, 3–600 seconds and no longer than
  `settings.max_video_post_duration_sec`, at least 360×360 pixels, 23–60 FPS.
- Photos: 1–35 JPEG/WebP images, at most 20 MB each, maximum 1080×1920 or 1920×1080 pixels.
  Custom video covers also accept PNG, with a minimum of 360×360 pixels; a custom cover overrides
  `thumbnail_offset`. Photo cover indexes are zero-based.
- Text limits use UTF-16 code units: 2,200 for video captions, 90 for photo titles, 4,000 for photo
  captions. TikTok additionally limits captions to 30 mentions and documents mentions/hashtags as
  plain text. Account-specific constraints and mention eligibility are enforced by TikTok.
- Fetch current settings before showing publishing controls. Sixb does not silently fetch settings,
  choose privacy/disclosure defaults, or override interaction preferences on submission.
- Publishing is asynchronous: poll `getStatus` with bounded backoff in your application.
  Handle `FAILED` using `reason`; `PUBLISH_COMPLETE` can initially lack `post_ids`. IDs are returned
  only for publicly viewable posts and may take up to three additional minutes. IDs remain strings.
- Both publishing endpoints document six submissions per minute and 15 per day per account.
  Scheduling, durable task tracking, and duplicate prevention belong in the application.
- Publication requests are **never automatically replayed**, even after a token rejection.
  A network timeout, malformed response, or failing `onResponse` callback can leave an unknown
  outcome: do not blindly submit again. Reconcile through the saved task ID when available or
  inspect the TikTok account. Reads retain their retry/refresh behavior. Keep `onResponse` reliable
  and use it to record TikTok's request/log IDs for support.

This surface covers URL-based publication and drafts, not Content Posting API file uploads,
commercial music-library selection, location tags, TikTok One campaigns, ad-only posts, or webhook
registration. Video audio can be prepared in the source file; photos support `auto_add_music`.

Contracts: [video](https://business-api.tiktok.com/portal/docs/publish-a-public-video-post-to-an-owned-account/v1.3),
[photos](https://business-api.tiktok.com/portal/docs/publish-a-photo-post-to-an-owned-account/v1.3),
[settings](https://business-api.tiktok.com/portal/docs/get-the-post-privacy-settings-of-a-tiktok-account/v1.3),
[status](https://business-api.tiktok.com/portal/docs/get-the-publishing-status-of-a-tiktok-post/v1.3).

## Operational notes

- Display and Business Organic access tokens expire after one day and are refreshed automatically.
  Their refresh tokens expire after one year, after which the account must be reauthorized. Sixb's
  current OAuth credential contract does not store a separate refresh-token expiry timestamp, so
  expiry is detected from TikTok's terminal refresh response rather than scheduled in advance.
- Marketing API access tokens are long-lived and have no refresh endpoint. A rejected token
  therefore produces a terminal reauthorization error.
- Profile insight windows are limited to 60 days; post statistics stop updating after 365 days.
- Reporting is passed through without a metric taxonomy. TikTok limits synchronous requests by
  dimensions and date range; split larger syncs at the project layer.
- `onResponse` exposes `requestId`, `X-Tt-Logid`, and raw `X-Tt-Ads-Throttle` metadata.
