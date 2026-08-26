# @sixb/connector-tiktok

Read-only TikTok API for Business v1.3 connector for organic account data and Ads reporting.
TikTok uses two separate OAuth grants, so register one connector definition per surface.

## Register

```ts
import { defineConnector } from "@sixb/core"
import { tiktok } from "@sixb/connector-tiktok"

export const tiktokOrganic = defineConnector(
  "tiktok-organic",
  tiktok({
    accountType: "organic-account",
    clientId: process.env.TIKTOK_CLIENT_ID!,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET!,
    authorizationUrl: process.env.TIKTOK_ACCOUNT_AUTHORIZATION_URL!,
  })
)

export const tiktokAds = defineConnector(
  "tiktok-ads",
  tiktok({
    accountType: "ad-account",
    appId: process.env.TIKTOK_APP_ID!,
    secret: process.env.TIKTOK_APP_SECRET!,
  })
)
```

For the organic grant, copy the complete account-holder authorization URL from the TikTok app
portal. Register Sixb's callback URL with a trailing slash; TikTok requires an exact HTTPS redirect
URI ending in `/`. The Ads grant uses TikTok's Marketing API authorization page and a long-lived,
non-refreshable access token.

TikTok does not document PKCE for either flow. Sixb still sends its required `code_challenge` on
the authorization request, but the connector does not send an undocumented `code_verifier` to the
token endpoints. Sixb's one-use state and callback browser binding remain enforced.

## Client API

Organic account:

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
for await (const post of organic.posts.listAll({
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

- Organic access tokens expire after one day and are refreshed automatically. TikTok refresh
  tokens expire after one year, after which the account must be reauthorized. Sixb's current OAuth
  credential contract does not store a separate refresh-token expiry timestamp, so expiry is
  detected from TikTok's terminal refresh response rather than scheduled in advance.
- Ads access tokens are long-lived and have no refresh endpoint. A rejected Ads token therefore
  produces a terminal reauthorization error.
- Profile insight windows are limited to 60 days; post statistics stop updating after 365 days.
- Reporting is passed through without a metric taxonomy. TikTok limits synchronous requests by
  dimensions and date range; split larger syncs at the project layer.
- `onResponse` exposes `requestId`, `X-Tt-Logid`, and raw `X-Tt-Ads-Throttle` metadata.
