# @sixb/connector-tiktok

Read-only connector for TikTok Display API, Business Account organic data, and Ads reporting.
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
| `organic` | Business Accounts API | Client ID / secret + portal authorization URL | Business profile insights, posts, comments |
| `marketing` | Marketing API | App ID / secret | Advertisers, campaigns, ad groups, ads, reports |

Display defaults to `user.info.basic` and `video.list`. Request `user.info.profile` and
`user.info.stats` only after TikTok approves those scopes for the app. Display exposes video
`comment_count`, but not comment contents.

For Business Organic, copy the complete account-holder authorization URL from the TikTok app
portal. Register Sixb's callback URL with a trailing slash; this flow requires an exact HTTPS
redirect URI ending in `/`. Marketing uses a long-lived, non-refreshable access token.

Login Kit Web does not use PKCE; TikTok documents it only for mobile and desktop. The two Business
flows retain Sixb's framework challenge on the authorization request without sending an
undocumented verifier. Sixb's one-use state and callback browser binding remain enforced.

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
