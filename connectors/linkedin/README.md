# @sixb/connector-linkedin

Typed LinkedIn Advertising and Community Management API connector for Sixb. It is a direct Rest.li
client for advertising entities and reporting, administered Pages, organic posts and engagement,
organization analytics, and authenticated-member analytics. The connector preserves LinkedIn wire
payloads instead of introducing a second domain model, so every request remains easy to compare
with the upstream documentation.

## Register

LinkedIn requires Community Management to be requested from an application that has no other
provisioned product. Register one connector definition per LinkedIn developer application while
the Advertising and Community products remain separate:

```ts
import { defineConnector } from "@sixb/core"
import { linkedin } from "@sixb/connector-linkedin"

export const linkedinAdvertising = defineConnector(
  "linkedin-advertising",
  linkedin({
    clientId: process.env.LINKEDIN_ADS_CLIENT_ID!,
    clientSecret: process.env.LINKEDIN_ADS_CLIENT_SECRET!,
    accountType: "ad-account",
    scopes: ["r_ads", "r_ads_reporting"],
  })
)

export const linkedinCommunity = defineConnector(
  "linkedin-community",
  linkedin({
    clientId: process.env.LINKEDIN_COMMUNITY_CLIENT_ID!,
    clientSecret: process.env.LINKEDIN_COMMUNITY_CLIENT_SECRET!,
    accountType: "organization",
    scopes: [
      "rw_organization_admin",
      "r_organization_social",
      "r_organization_social_feed",
    ],
  })
)
```

`createSixb()` discovers definitions in the project's `connectors/` directory. Sixb owns the OAuth
state, encrypted credentials, account selection, refresh coordination, and connection lifecycle.
Register the server-owned callback URL in each LinkedIn application:

```text
https://<sixb-api-origin>/auth/connectors/callback
```

The `accountType` controls the accounts offered by Sixb after authorization:

- `ad-account` calls `adAccountUsers?q=authenticatedUser`, then presents the accessible Campaign
  Manager accounts.
- `organization` calls `organizationAcls?q=roleAssignee`, then presents the approved administered
  Pages.

Advertising and Community grants therefore remain isolated while application code resolves each
connection by its stable slot:

```ts
const li = await sixb.connector(linkedinCommunity, {
  owner: { type: "project" },
  slot: "organic-marketing",
})

console.log(li.account) // Selected organization URN and label
```

## Access and versioning

The client targets LinkedIn's versioned `/rest` API and sends both required headers on every call:

- `Linkedin-Version: 202608` by default
- `X-Restli-Protocol-Version: 2.0.0`

Pass `version` explicitly when pinning a different supported monthly version. LinkedIn sunsets
Marketing API versions, so upgrading the version should be an intentional application change.

The application and member must have the relevant LinkedIn API product and OAuth scopes. A
Community Management Development Tier request must start on a new LinkedIn developer application
with no other provisioned product. LinkedIn's current Standard Tier process can subsequently add
Community Management to an existing Advertising API application after the separate application has
been approved and used for verification. Until that upgrade, configure the Advertising and
Community connector instances with their respective application credentials and OAuth scopes.

| Operation | OAuth scope |
| --- | --- |
| Read advertising entities | `r_ads` |
| Create or update advertising entities | `rw_ads` |
| Read ad analytics and revenue attribution | `r_ads_reporting` |
| Discover Page roles, read organization details, and read Page/follower/share analytics | `rw_organization_admin` |
| Read organization posts and organization video analytics | `r_organization_social` |
| Create, update, or delete organization posts | `w_organization_social` |
| Read organization comments, reactions, and social metadata | `r_organization_social_feed` |
| Create, update, or delete organization comments and reactions | `w_organization_social_feed` |
| Create, update, or delete member posts | `w_member_social` |
| Create, update, or delete member comments and reactions | `w_member_social_feed` |
| Read member posts, comments, and reactions | `r_member_social_feed` (restricted) |
| Read the authenticated member's follower analytics | `r_member_profileAnalytics` |
| Read the authenticated member's post and video analytics | `r_member_postAnalytics` |

The connector implements LinkedIn's confidential authorization-code flow. LinkedIn only issues
programmatic refresh tokens to eligible approved partners. If no refresh token is present, Sixb
keeps the access token until its documented expiry and then moves the connection to
`needs_reauthorization`; it never invents a refresh path. LinkedIn also returns a separate refresh
token lifetime, which the current core credential contract cannot store. When that lifetime ends,
the provider's definitive `invalid_grant` response moves the connection to the same reauthorization
state.

### LinkedIn PKCE compatibility

Sixb currently requires every managed OAuth adapter to preserve its `state`, `code_challenge`, and
`code_challenge_method=S256` parameters. LinkedIn documents PKCE only for a separate native flow
that requires loopback callback URLs, while Sixb uses a server-owned HTTPS callback and LinkedIn's
confidential web flow. The connector preserves the core-provided PKCE parameters on the standard
authorization URL so the adapter passes core validation, but it does not send the undocumented
`code_verifier` to LinkedIn's confidential token endpoint. Consequently, the LinkedIn flow relies
on Sixb's one-use state and HttpOnly browser binding, the exact HTTPS redirect URI, and the
application secret until the core can make PKCE capability provider-specific.

## Options

| Option | Description |
| --- | --- |
| `clientId` | Required LinkedIn developer application client ID. |
| `clientSecret` | Required LinkedIn developer application client secret. |
| `scopes` | Required least-privilege list of LinkedIn OAuth scopes. |
| `accountType` | `ad-account` or `organization`; determines managed account discovery. |
| `version` | LinkedIn Marketing API version without a dash. Defaults to `202608`. |
| `baseUrl` | Defaults to `https://api.linkedin.com/rest/`; mainly useful for testing. |
| `timeoutMs` | Optional timeout for each request attempt. |
| `minDelayMs` | Optional minimum delay between request starts. |
| `retry` | Method-aware transient-failure policy. Defaults to two retries for reads only. |
| `queryTunnelingThreshold` | Query byte length at which GET query tunneling is used. Defaults to 3500. |

Retries cover network errors, `429`, and `5xx` responses and honor `Retry-After`. Writes are not
retried by default because an interrupted create or update may already have been applied upstream.
For reads, a `401` invalidates the exact token revision and safely replays the request once with the
token supplied by Sixb. A write that returns `401` is never replayed or invalidated through the REST
layer because its upstream effect may be ambiguous.

## Advertising API

| Client method | LinkedIn endpoint |
| --- | --- |
| `li.adAccounts.get(id)` | `GET /adAccounts/{id}` |
| `li.adAccounts.search(options?)` / `.searchAll(options?)` | `GET /adAccounts?q=search` |
| `li.adAccounts.create(input)` | `POST /adAccounts` |
| `li.adAccounts.update(id, input)` | `POST /adAccounts/{id}` partial update |
| `li.adAccountUsers.get(account, user)` | `GET /adAccountUsers/(account:...,user:...)` |
| `li.adAccountUsers.listByAccount(account, options?)` | `GET /adAccountUsers?q=accounts` |
| `li.adAccountUsers.listByAuthenticatedUser(options?)` | `GET /adAccountUsers?q=authenticatedUser` |
| `li.adAccountUsers.grant(input)` / `.update(input)` / `.revoke(account, user)` | Account user writes |
| `li.adAccount(id).campaignGroups.*` | `/adAccounts/{id}/adCampaignGroups` |
| `li.adAccount(id).campaigns.*` | `/adAccounts/{id}/adCampaigns` |
| `li.adAccount(id).creatives.*` | `/adAccounts/{id}/creatives` |
| `li.adAnalytics.analytics(query)` | `GET /adAnalytics?q=analytics` |
| `li.adAnalytics.statistics(query)` | `GET /adAnalytics?q=statistics` |
| `li.adAnalytics.attributedRevenue(query)` | `GET /adAnalytics?q=attributedRevenueMetrics` |

Every search method returns one normalized page with `items` and the upstream next-page token.
`searchAll()` is an async iterator that follows tokens and fails if LinkedIn repeats one, avoiding
an accidental infinite sync.

```ts
for await (const campaign of li.adAccount(123).campaigns.searchAll({
  statuses: ["ACTIVE"],
  pageSize: 100,
})) {
  // Persist the upstream campaign as-is or map it into an ontology object.
}
```

URN helpers provide the exact template-literal types used by LinkedIn:

```ts
import { sponsoredAccountUrn, sponsoredCampaignUrn } from "@sixb/connector-linkedin"

const account = sponsoredAccountUrn(123)
const campaign = sponsoredCampaignUrn(456)
```

## Reporting

Reporting validates dates, field count, and pivot count before making a request. Metric names remain
open strings because LinkedIn changes the reporting schema monthly; supply a row generic when the
selected fields are known locally:

```ts
type CampaignMetrics = {
  readonly pivotValues: readonly string[]
  readonly impressions: number
  readonly costInLocalCurrency: string
}

const rows = await li.adAnalytics.analytics<CampaignMetrics>({
  pivot: "CAMPAIGN",
  dateRange: { start: { year: 2026, month: 8, day: 1 } },
  timeGranularity: "DAILY",
  fields: ["pivotValues", "impressions", "costInLocalCurrency"],
  accounts: [sponsoredAccountUrn(123)],
})
```

Long reporting queries automatically use LinkedIn's query-tunneling convention: a form-encoded
`POST` with `X-HTTP-Method-Override: GET`. This changes only the transport; retry policy still treats
the operation as a read.

## Community Management API

The Community surfaces cover the core Page-management and organic-data flow:

| Client method | LinkedIn endpoint |
| --- | --- |
| `li.organizationAcls.listForAuthenticatedMember(options?)` | `GET /organizationAcls?q=roleAssignee` |
| `li.organizationAcls.listByOrganization(organization, options?)` | `GET /organizationAcls?q=organization` |
| `li.organizations.get(id)` | `GET /organizations/{id}` |
| `li.organizations.findByVanityName(name)` | `GET /organizations?q=vanityName` |
| `li.organizations.listByParent(parent, options?)` | `GET /organizations?q=parentOrganization` |
| `li.organizations.followerCount(organization)` | `GET /networkSizes/{organization}` |
| `li.posts.get(post, viewContext?)` | `GET /posts/{post}` |
| `li.posts.listByAuthor(author, options?)` / `.listAllByAuthor(...)` | `GET /posts?q=author` |
| `li.posts.create(input)` / `.update(post, input)` / `.delete(post)` | Post writes |
| `li.socialMetadata.get(entity)` / `.setCommentsState(entity, actor, state)` | `/socialMetadata/{entity}` |
| `li.comments.list(entity, options?)` / `.get(entity, id)` | `/socialActions/{entity}/comments` |
| `li.comments.create(...)` / `.update(...)` / `.delete(...)` | Comment writes |
| `li.reactions.get(actor, entity)` / `.listByEntity(entity, options?)` | `/reactions` reads |
| `li.reactions.create(input)` / `.delete(actor, entity)` | Reaction writes |
| `li.images.get(urn)` / `li.videos.get(urn)` / `li.documents.get(urn)` | Media metadata and signed download URLs |
| `li.organizationAnalytics.followers(organization, intervals?)` | `/organizationalEntityFollowerStatistics` |
| `li.organizationAnalytics.pages(organization, intervals?)` | `/organizationPageStatistics` |
| `li.organizationAnalytics.shares(organization, query?)` | `/organizationalEntityShareStatistics` |
| `li.organizationAnalytics.video(query)` | `/videoAnalytics` |
| `li.memberAnalytics.followers()` / `.followerHistory(range?)` | `/memberFollowersCount` |
| `li.memberAnalytics.post(query)` / `.posts(query)` | `/memberCreatorPostAnalytics` |
| `li.memberAnalytics.video(query)` | `/memberCreatorVideoAnalytics` |

Start by discovering the organizations administered by the signed-in member, then load organic
content and analytics with the returned organization URN:

```ts
const roles = await li.organizationAcls.listForAuthenticatedMember({
  role: "ADMINISTRATOR",
  state: "APPROVED",
})

for (const role of roles.items) {
  const organization = role.organizationTarget ?? role.organization
  if (!organization) continue

  const posts = li.posts.listAllByAuthor(organization, { sortBy: "LAST_MODIFIED" })
  const followerCount = await li.organizations.followerCount(organization)
  const lifetimeShareStats = await li.organizationAnalytics.shares(organization)
  // Persist `posts`, `followerCount`, and `lifetimeShareStats` in the desired datasets.
}
```

Posts are modeled as the versioned `/posts` wire format. `content` types article, media,
multi-image, poll, reference, carousel, and celebration payloads while remaining open to new
LinkedIn formats. Resolve image, video, and document URNs through `li.images`, `li.videos`, and
`li.documents`; their signed download URLs can expire, so resolve them close to use. Upload
initialization and multipart transfer remain explicit upstream workflows and are not hidden behind
post creation.

Organization share analytics are organic-only and limited upstream to a rolling 12-month window.
Use `li.adAnalytics` for sponsored performance. Lifetime follower demographics also have an
important LinkedIn wire-format detail: the `organicFollowerCount` field contains the rolled-up paid
and organic total for demographic facets. Use `li.organizations.followerCount(...)` for the current
total Page follower count.

Member analytics always concern the member represented by the access token. They do not provide
analytics for arbitrary member profiles. Reading member-authored posts still depends on
`r_member_social`, which LinkedIn currently treats as a closed permission; Page-authored posts use
the organization scopes above.

### Development Tier behavior

LinkedIn's Community Management Development Tier currently limits traffic to 500 calls per
application per day and 100 calls per member per day. It also excludes `BATCH_GET` and social-action
webhooks. The client therefore exposes offset iterators instead of batch convenience methods and
does not advertise a webhook surface that would fail in Development Tier.

Offset iterators honor `paging.links[rel=next]`. This matters for `/posts`, which may return fewer
items than requested even though a next page exists. Iteration also rejects a non-advancing offset
instead of looping forever.

## Resource behavior

- Most creation methods return `{ id }` from LinkedIn's `x-restli-id` response header. Comment
  creation also returns the parsed comment as `data`, including the composite `commentUrn` needed
  for nested replies. Reaction creation returns LinkedIn's reaction response directly.
- Updates use Rest.li partial updates and reject empty patches locally.
- `deleteDraft` is named narrowly because LinkedIn only permits hard deletion for eligible entities
  such as drafts. For other entities, use `update` with `PENDING_DELETION` as documented by LinkedIn.
- Creative content unions and analytics metrics are intentionally extensible. Stable common fields
  are typed, while new upstream formats and metrics pass through without data loss.
- `LinkedinApiError` exposes status, service code, request ID, response headers, and the parsed
  upstream error body for observability.

LinkedIn imposes application- and member-level rate limits and returns their current values through
developer tooling rather than fixed API headers. Use `minDelayMs`, the default transient read retry,
and workflow-level scheduling according to the limits assigned to the application.

Before creating campaigns, applications remain responsible for LinkedIn's current advertising
policies, audience targeting restrictions, and any political advertising declarations required for
the served region.

## References

- [LinkedIn Advertising API quick start](https://learn.microsoft.com/en-us/linkedin/marketing/quick-start?view=li-lms-2026-08)
- [Community Management overview](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-08)
- [Community Management permissions](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access?view=li-lms-2026-08)
- [Organization access control](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-08)
- [Organization lookup](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api?view=li-lms-2026-08)
- [Posts](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-08)
- [Comments](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api?view=li-lms-2026-08)
- [Reactions](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api?view=li-lms-2026-08)
- [Social metadata](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/social-metadata-api?view=li-lms-2026-08)
- [Images](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-08)
- [Videos](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-08)
- [Documents](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api?view=li-lms-2026-08)
- [Organization follower, Page, share, and video analytics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-08#page-analytics)
- [Member analytics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-08#member-analytics)
- [Ad account structure](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-08)
- [Ad reporting](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-08)
- [Marketing API versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning?view=li-lms-2026-08)
- [Rest.li query tunneling](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/query-tunneling)
- [LinkedIn authorization code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)
- [LinkedIn programmatic refresh tokens](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)
- [LinkedIn native PKCE flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native)
- [Sixb connectors](https://docs.sixb.ai/data/connectors)
- [Sixb managed OAuth implementation](https://github.com/sixb-ai/sixb/issues/384)
