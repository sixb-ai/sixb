import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ConnectorOAuthError } from "@sixb/core"
import { TiktokApiError, tiktok } from "../src"

const originalFetch = globalThis.fetch
const signal = new AbortController().signal
const context = { projectId: "demo", connectorId: "tiktok", signal }
const authorizationContext = {
  ...context,
  redirectUri: "https://api.example.com/auth/connectors/callback",
}
const authorizationInput = {
  state: "signed-state",
  codeChallenge: "pkce-challenge",
  codeChallengeMethod: "S256" as const,
}

beforeEach(() => {
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("TikTok OAuth", () => {
  test("builds the organic account-holder URL with its exact trailing-slash redirect", () => {
    const adapter = organicAdapter()
    const url = new URL(
      adapter.authentication.authorizationUrl(authorizationContext, authorizationInput).toString()
    )

    expect(url.origin).toBe("https://www.tiktok.com")
    expect(url.searchParams.get("client_key")).toBe("portal-client")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/connectors/callback/"
    )
    expect(url.searchParams.get("state")).toBe("signed-state")
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("disable_auto_auth")).toBe("1")
  })

  test("exchanges and refreshes organic tokens without sending an undocumented verifier", async () => {
    const requests: CapturedRequest[] = []
    mockFetch(async (input, init) => {
      requests.push({ input, init })
      const path = new URL(String(input)).pathname
      if (path.endsWith("/refresh_token/")) {
        return json({
          code: 0,
          message: "OK",
          data: organicToken("access-2", "refresh-2"),
        })
      }
      return json({
        code: 0,
        message: "OK",
        request_id: "request-1",
        data: organicToken("access-1", "refresh-1"),
      })
    })

    const adapter = organicAdapter()
    const exchanged = await adapter.authentication.exchangeCode(authorizationContext, {
      code: "provider-code",
      codeVerifier: "must-not-leave-sixb",
    })
    const refreshed = await adapter.authentication.refresh(context, exchanged)

    expect(exchanged.accessToken).toBe("access-1")
    expect(exchanged.refreshToken).toBe("refresh-1")
    expect(exchanged.scopes).toEqual(["user.info.basic", "video.list"])
    expect(exchanged.expiresAt?.getTime()).toBeGreaterThan(Date.now())
    expect(refreshed.accessToken).toBe("access-2")
    expect(requestBody(requests[0])).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      grant_type: "authorization_code",
      auth_code: "provider-code",
      redirect_uri: "https://api.example.com/auth/connectors/callback/",
    })
    expect(JSON.stringify(requestBody(requests[0]))).not.toContain("must-not-leave-sixb")
    expect(requestBody(requests[1])).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    })
  })

  test("builds and exchanges the distinct Ads grant", async () => {
    const requests: CapturedRequest[] = []
    mockFetch(async (input, init) => {
      requests.push({ input, init })
      return new Response(
        '{"code":0,"message":"OK","data":{"access_token":"ads-token","advertiser_ids":["adv-1"],"scope":[9007199254740993]}}',
        { headers: { "content-type": "application/json" } }
      )
    })

    const adapter = adsAdapter()
    const url = new URL(
      adapter.authentication.authorizationUrl(authorizationContext, authorizationInput).toString()
    )
    const credentials = await adapter.authentication.exchangeCode(authorizationContext, {
      code: "ads-code",
      codeVerifier: "must-not-leave-sixb",
    })

    expect(url.toString()).toStartWith("https://ads.tiktok.com/marketing_api/auth?")
    expect(url.searchParams.get("app_id")).toBe("app-id")
    expect(url.searchParams.get("redirect_uri")).toBe(authorizationContext.redirectUri)
    expect(url.searchParams.get("scope")).toBe("ads.read")
    expect(credentials).toEqual({
      accessToken: "ads-token",
      tokenType: "Bearer",
      scopes: ["ads.read"],
    })
    expect(requestBody(requests[0])).toEqual({
      app_id: "app-id",
      secret: "app-secret",
      auth_code: "ads-code",
      return_advertiser_ids: true,
    })
  })

  test("marks Ads refresh as terminal because TikTok has no refresh endpoint", () => {
    const adapter = adsAdapter()
    expect(() => adapter.authentication.refresh(context, { accessToken: "ads-token" })).toThrow(
      ConnectorOAuthError
    )
    try {
      adapter.authentication.refresh(context, { accessToken: "ads-token" })
    } catch (error) {
      expect((error as ConnectorOAuthError).kind).toBe("terminal")
    }
  })

  test("revokes each grant through its own endpoint and authentication shape", async () => {
    const requests: CapturedRequest[] = []
    mockFetch(async (input, init) => {
      requests.push({ input, init })
      return json({ code: 0, message: "OK", data: {} })
    })

    await organicAdapter().authentication.revoke?.(context, { accessToken: "organic-token" })
    await adsAdapter().authentication.revoke?.(context, { accessToken: "ads-token" })

    expect(requests.map((request) => new URL(String(request.input)).pathname)).toEqual([
      "/open_api/v1.3/tt_user/oauth2/revoke/",
      "/open_api/v1.3/oauth2/revoke_token/",
    ])
    expect(requestBody(requests[0])).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      access_token: "organic-token",
    })
    expect(requestBody(requests[1])).toEqual({
      app_id: "app-id",
      secret: "app-secret",
      access_token: "ads-token",
    })
    expect(new Headers(requests[1]?.init?.headers).get("access-token")).toBe("ads-token")
  })

  test("classifies a malformed successful token response as ambiguous", async () => {
    mockFetch(async () => json({ code: 0, message: "OK", data: { access_token: "partial" } }))

    try {
      await organicAdapter().authentication.exchangeCode(authorizationContext, {
        code: "provider-code",
        codeVerifier: "verifier",
      })
      throw new Error("expected exchange to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorOAuthError)
      expect((error as ConnectorOAuthError).kind).toBe("ambiguous")
    }
  })
})

describe("TikTok organic resources", () => {
  test("discovers the creator account through the token inspector", async () => {
    const requests: CapturedRequest[] = []
    mockFetch(async (input, init) => {
      requests.push({ input, init })
      const path = new URL(String(input)).pathname
      return path.endsWith("/tt_user/token_info/get/")
        ? json({ code: 0, message: "OK", data: { creator_id: "creator-1" } })
        : json({
            code: 0,
            message: "OK",
            data: {
              display_name: "Acme TikTok",
              username: "acme",
              profile_image: "https://cdn.example.com/avatar.jpg",
            },
          })
    })

    const accounts = await organicAdapter().discoverAccounts(context, {
      accessToken: "organic-token",
    })

    expect(accounts).toEqual([
      {
        id: "creator-1",
        label: "Acme TikTok",
        description: "@acme",
        avatarUrl: "https://cdn.example.com/avatar.jpg",
      },
    ])
    expect(requestBody(requests[0])).toEqual({
      app_id: "client-id",
      access_token: "organic-token",
    })
    expect(new Headers(requests[0]?.init?.headers).get("access-token")).toBeNull()
    expect(new Headers(requests[1]?.init?.headers).get("access-token")).toBe("organic-token")
  })

  test("paginates posts and serializes TikTok fields and filters as JSON", async () => {
    const requests: CapturedRequest[] = []
    mockFetch(async (input, init) => {
      requests.push({ input, init })
      const cursor = new URL(String(input)).searchParams.get("cursor")
      return cursor
        ? json({
            code: 0,
            message: "OK",
            data: { videos: [{ item_id: "post-2" }], cursor: 200, has_more: false },
          })
        : json({
            code: 0,
            message: "OK",
            data: { videos: [{ item_id: "post-1" }], cursor: 100, has_more: true },
          })
    })

    const client = await organicClient()
    const posts = await collect(
      client.posts.listAll({
        fields: ["item_id", "video_views"],
        videoIds: ["post-1", "post-2"],
        adPostOnly: false,
        maxCount: 20,
      })
    )

    expect(posts.map((post) => post.item_id)).toEqual(["post-1", "post-2"])
    const first = new URL(String(requests[0]?.input))
    const second = new URL(String(requests[1]?.input))
    expect(JSON.parse(first.searchParams.get("fields") ?? "null")).toEqual([
      "item_id",
      "video_views",
    ])
    expect(JSON.parse(first.searchParams.get("filters") ?? "null")).toEqual({
      video_ids: ["post-1", "post-2"],
      ad_post_only: false,
    })
    expect(second.searchParams.get("cursor")).toBe("100")
    expect(first.searchParams.get("business_id")).toBe("creator-1")
  })

  test("lists replies with the selected account and comment identifiers", async () => {
    let requested = ""
    mockFetch(async (input) => {
      requested = String(input)
      return json({
        code: 0,
        message: "OK",
        data: { comments: [{ comment_id: "reply-1", video_id: "video-1" }], has_more: false },
      })
    })

    const client = await organicClient()
    const page = await client.comments.replies.list({
      videoId: "video-1",
      commentId: "comment-1",
      status: "PUBLIC",
      maxCount: 30,
    })

    expect(page.items[0]?.comment_id).toBe("reply-1")
    const url = new URL(requested)
    expect(url.pathname).toEndWith("/business/comment/reply/list/")
    expect(url.searchParams.get("business_id")).toBe("creator-1")
    expect(url.searchParams.get("comment_id")).toBe("comment-1")
  })

  test("requests profile insights and top-level comments with documented parameters", async () => {
    const requests: string[] = []
    mockFetch(async (input) => {
      requests.push(String(input))
      const path = new URL(String(input)).pathname
      return path.endsWith("/business/get/")
        ? json({
            code: 0,
            message: "OK",
            data: { display_name: "Acme", metrics: [{ date: "2026-08-01", video_views: 12 }] },
          })
        : json({
            code: 0,
            message: "OK",
            data: { comments: [{ comment_id: "comment-1", video_id: "video-1" }], has_more: false },
          })
    })

    const client = await organicClient()
    const profile = await client.profile.get({
      startDate: "2026-08-01",
      endDate: "2026-08-02",
      fields: ["display_name", "video_views"],
    })
    const comments = await client.comments.list({
      videoId: "video-1",
      includeReplies: true,
      sortField: "create_time",
      sortOrder: "desc",
    })

    expect(profile.metrics?.[0]?.video_views).toBe(12)
    expect(comments.items[0]?.comment_id).toBe("comment-1")
    const profileUrl = new URL(requests[0] ?? "")
    const commentsUrl = new URL(requests[1] ?? "")
    expect(profileUrl.searchParams.get("start_date")).toBe("2026-08-01")
    expect(profileUrl.searchParams.get("end_date")).toBe("2026-08-02")
    expect(commentsUrl.searchParams.get("include_replies")).toBe("true")
    expect(commentsUrl.searchParams.get("sort_order")).toBe("desc")
  })
})

describe("TikTok Ads resources", () => {
  test("discovers authorized advertiser accounts", async () => {
    let requested = ""
    mockFetch(async (input, init) => {
      requested = String(input)
      expect(new Headers(init?.headers).get("access-token")).toBe("ads-token")
      return json({
        code: 0,
        message: "OK",
        data: { list: [{ advertiser_id: "adv-1", advertiser_name: "Acme Ads" }] },
      })
    })

    const accounts = await adsAdapter().discoverAccounts(context, { accessToken: "ads-token" })

    expect(accounts).toEqual([{ id: "adv-1", label: "Acme Ads" }])
    const url = new URL(requested)
    expect(url.pathname).toEndWith("/oauth2/advertiser/get/")
    expect(url.searchParams.get("app_id")).toBe("app-id")
    expect(url.searchParams.get("secret")).toBe("app-secret")
  })

  test("scopes campaign pagination to the selected advertiser", async () => {
    const requests: string[] = []
    mockFetch(async (input) => {
      requests.push(String(input))
      const page = Number(new URL(String(input)).searchParams.get("page"))
      return json({
        code: 0,
        message: "OK",
        data: {
          list: [{ advertiser_id: "adv-1", campaign_id: `campaign-${page}` }],
          page_info: { page, page_size: 1, total_number: 2, total_page: 2 },
        },
      })
    })

    const client = await adsClient()
    const campaigns = await collect(
      client.campaigns.listAll({
        fields: ["campaign_id", "campaign_name"],
        filtering: { campaign_ids: ["campaign-1"] },
        pageSize: 1,
      })
    )

    expect(campaigns.map((campaign) => campaign.campaign_id)).toEqual(["campaign-1", "campaign-2"])
    expect(requests.map((request) => new URL(request).searchParams.get("advertiser_id"))).toEqual([
      "adv-1",
      "adv-1",
    ])
    expect(JSON.parse(new URL(requests[0] ?? "").searchParams.get("filtering") ?? "null")).toEqual({
      campaign_ids: ["campaign-1"],
    })
  })

  test("runs paginated reports and exposes Ads throttle metadata", async () => {
    const observed: string[] = []
    const requests: string[] = []
    mockFetch(async (input) => {
      requests.push(String(input))
      const page = Number(new URL(String(input)).searchParams.get("page"))
      return json(
        {
          code: 0,
          message: "OK",
          request_id: `request-${page}`,
          data: {
            list: [{ dimensions: { ad_id: `ad-${page}` }, metrics: { spend: "1.20" } }],
            page_info: { page, page_size: 1, total_number: 2, total_page: 2 },
          },
        },
        { headers: { "x-tt-ads-throttle": `quota-${page}` } }
      )
    })

    const client = await adsClient((metadata) => {
      if (metadata.adsThrottle) observed.push(metadata.adsThrottle)
    })
    const rows = await collect(
      client.reports.runAll({
        serviceType: "AUCTION",
        reportType: "BASIC",
        dataLevel: "AUCTION_AD",
        dimensions: ["ad_id"],
        metrics: ["spend"],
        startDate: "2026-08-01",
        endDate: "2026-08-02",
        pageSize: 1,
      })
    )

    expect(rows.map((row) => row.metrics.spend)).toEqual(["1.20", "1.20"])
    expect(observed).toEqual(["quota-1", "quota-2"])
    const url = new URL(requests[0] ?? "")
    expect(url.searchParams.get("advertiser_id")).toBe("adv-1")
    expect(JSON.parse(url.searchParams.get("dimensions") ?? "null")).toEqual(["ad_id"])
    expect(JSON.parse(url.searchParams.get("metrics") ?? "null")).toEqual(["spend"])
  })

  test("reads advertiser, ad-group, and ad resources from their documented endpoints", async () => {
    const requests: string[] = []
    mockFetch(async (input) => {
      requests.push(String(input))
      const path = new URL(String(input)).pathname
      if (path.endsWith("/advertiser/info/")) {
        return json({
          code: 0,
          message: "OK",
          data: { list: [{ advertiser_id: "adv-1", name: "Acme Ads", currency: "USD" }] },
        })
      }
      const list = path.endsWith("/adgroup/get/")
        ? [{ advertiser_id: "adv-1", campaign_id: "campaign-1", adgroup_id: "group-1" }]
        : [
            {
              advertiser_id: "adv-1",
              campaign_id: "campaign-1",
              adgroup_id: "group-1",
              ad_id: "ad-1",
            },
          ]
      return json({
        code: 0,
        message: "OK",
        data: { list, page_info: { page: 1, page_size: 100, total_number: 1 } },
      })
    })

    const client = await adsClient()
    const advertiser = await client.adAccount.get(["advertiser_id", "name", "currency"])
    const adGroups = await client.adGroups.list({ pageSize: 100 })
    const ads = await client.ads.list({ pageSize: 100 })

    expect(advertiser.currency).toBe("USD")
    expect(adGroups.items[0]?.adgroup_id).toBe("group-1")
    expect(ads.items[0]?.ad_id).toBe("ad-1")
    expect(requests.map((request) => new URL(request).pathname)).toEqual([
      "/open_api/v1.3/advertiser/info/",
      "/open_api/v1.3/adgroup/get/",
      "/open_api/v1.3/ad/get/",
    ])
    for (const request of requests) {
      const url = new URL(request)
      const advertiserIds = url.searchParams.get("advertiser_ids")
      expect(url.searchParams.get("advertiser_id") ?? advertiserIds).toContain("adv-1")
    }
  })

  test("invalidates a rejected token and retries once with the refreshed value", async () => {
    const usedTokens: string[] = []
    mockFetch(async (_input, init) => {
      const token = new Headers(init?.headers).get("access-token") ?? ""
      usedTokens.push(token)
      return token === "old-token"
        ? json({ code: 40100, message: "Access token is invalid", data: {} }, { status: 401 })
        : json({
            code: 0,
            message: "OK",
            data: {
              list: [{ advertiser_id: "adv-1", name: "Acme" }],
            },
          })
    })

    let invalidated = false
    const adapter = adsAdapter()
    const client = await adapter.connect({
      ...context,
      connectionId: "connection-1",
      account: { id: "adv-1", label: "Acme" },
      tokenSource: {
        async get() {
          const accessToken = invalidated ? "new-token" : "old-token"
          return { accessToken, invalidate: () => (invalidated = true) }
        },
      },
    })

    expect((await client.adAccount.get()).name).toBe("Acme")
    expect(usedTokens).toEqual(["old-token", "new-token"])
  })

  test("preserves structured API failures", async () => {
    mockFetch(async () =>
      json({ code: 40002, message: "Invalid advertiser", request_id: "req-bad", data: {} })
    )
    const client = await adsClient()

    try {
      await client.ads.list()
      throw new Error("expected request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(TiktokApiError)
      expect((error as TiktokApiError).code).toBe(40002)
      expect((error as TiktokApiError).requestId).toBe("req-bad")
    }
  })
})

function organicAdapter() {
  return tiktok({
    accountType: "organic-account",
    clientId: "client-id",
    clientSecret: "client-secret",
    authorizationUrl:
      "https://www.tiktok.com/v2/auth/authorize/?client_key=portal-client&response_type=code",
    disableAutoAuth: true,
    baseUrl: "https://business-api.example.com/open_api/v1.3/",
    retry: { maxRetries: 0 },
  })
}

function adsAdapter(onResponse?: Parameters<typeof tiktok>[0]["onResponse"]) {
  return tiktok({
    accountType: "ad-account",
    appId: "app-id",
    secret: "app-secret",
    scope: "ads.read",
    baseUrl: "https://business-api.example.com/open_api/v1.3/",
    retry: { maxRetries: 0 },
    onResponse,
  })
}

async function organicClient() {
  return organicAdapter().connect({
    ...context,
    connectionId: "connection-1",
    account: { id: "creator-1", label: "Acme TikTok" },
    tokenSource: staticToken("organic-token"),
  })
}

async function adsClient(onResponse?: Parameters<typeof tiktok>[0]["onResponse"]) {
  const adapter = tiktok({
    accountType: "ad-account",
    appId: "app-id",
    secret: "app-secret",
    baseUrl: "https://business-api.example.com/open_api/v1.3/",
    retry: { maxRetries: 0 },
    onResponse,
  })
  return adapter.connect({
    ...context,
    connectionId: "connection-1",
    account: { id: "adv-1", label: "Acme Ads" },
    tokenSource: staticToken("ads-token"),
  })
}

function staticToken(accessToken: string) {
  return {
    async get() {
      return { accessToken, invalidate() {} }
    },
  }
}

function organicToken(accessToken: string, refreshToken: string) {
  return {
    access_token: accessToken,
    expires_in: 86_400,
    refresh_token: refreshToken,
    refresh_token_expires_in: 31_536_000,
    scope: "user.info.basic,video.list",
    token_type: "Bearer",
  }
}

type CapturedRequest = {
  readonly input: RequestInfo | URL
  readonly init?: RequestInit
}

function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = implementation as typeof fetch
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

function requestBody(request: CapturedRequest | undefined): unknown {
  return JSON.parse(String(request?.init?.body))
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}
