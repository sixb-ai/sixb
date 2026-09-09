import { afterEach, describe, expect, test } from "bun:test"
import {
  type LinkedinOrganizationFollowerStatistic,
  type LinkedinOrganizationPageStatistic,
  organizationUrn,
  shareUrn,
  ugcPostUrn,
} from "../src"
import { createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin community analytics", () => {
  test("serializes organization follower, page, and video analytics", async () => {
    const organization = organizationUrn(123)
    const ugcPost = ugcPostUrn(789)
    // Regression guard: these 202608-shaped fixtures must satisfy the public wire types.
    const followerStatistic = {
      organizationalEntity: organization,
      followerGains: { organicFollowerGain: 223, paidFollowerGain: 12 },
      timeRange: { start: 1_700_000_000_000, end: 1_700_086_400_000 },
    } as const satisfies LinkedinOrganizationFollowerStatistic
    const pageStatistic = {
      organization,
      totalPageStatistics: {
        clicks: {
          desktopCustomButtonClickCounts: [{ clicks: 4, customButtonType: "VISIT_WEBSITE" }],
          mobileCustomButtonClickCounts: [{ clicks: 2, customButtonType: "VISIT_WEBSITE" }],
        },
        views: {
          allPageViews: { pageViews: 42, uniquePageViews: 31 },
          overviewPageViews: { pageViews: 40, uniquePageViews: 30 },
        },
      },
      pageStatisticsByIndustryV2: [
        {
          industryV2: "urn:li:industry:4",
          pageStatistics: { views: { allPageViews: { pageViews: 6 } } },
        },
      ],
      timeRange: { start: 1_700_000_000_000, end: 1_700_086_400_000 },
    } as const satisfies LinkedinOrganizationPageStatistic
    const calls = recorder([
      json({ elements: [followerStatistic] }),
      json({ elements: [pageStatistic] }),
      json({ elements: [{ entity: ugcPost, value: 100 }] }),
    ])
    const client = await createTestClient()

    const followers = await client.organizationAnalytics.followers(organization, {
      timeRange: { start: 1_700_000_000_000, end: 1_700_086_400_000 },
      timeGranularityType: "DAY",
    })
    const pages = await client.organizationAnalytics.pages(organization)
    await client.organizationAnalytics.video({
      entity: ugcPost,
      type: "TIME_WATCHED_FOR_VIDEO_VIEWS",
      aggregation: "DAY",
      timeRange: { start: 1_700_000_000_000, end: 1_700_086_400_000 },
    })

    expect(new URL(calls[0]?.url ?? "").searchParams.get("timeIntervals")).toBe(
      "(timeRange:(start:1700000000000,end:1700086400000),timeGranularityType:DAY)"
    )
    expect(new URL(calls[1]?.url ?? "").searchParams.get("q")).toBe("organization")
    expect(new URL(calls[2]?.url ?? "").searchParams.get("type")).toBe(
      "TIME_WATCHED_FOR_VIDEO_VIEWS"
    )
    expect(new URL(calls[2]?.url ?? "").searchParams.get("timeRange")).toBe(
      "(start:1700000000000,end:1700086400000)"
    )
    expect(followers[0]?.followerGains?.organicFollowerGain).toBe(223)
    expect(pages[0]?.totalPageStatistics?.views?.allPageViews?.uniquePageViews).toBe(31)
    expect(pages[0]?.totalPageStatistics?.clicks?.desktopCustomButtonClickCounts?.[0]?.clicks).toBe(
      4
    )
    expect(pages[0]?.pageStatisticsByIndustryV2?.[0]?.pageStatistics.views?.allPageViews).toEqual({
      pageViews: 6,
    })
  })

  // Regression guard: restore indexed ugcPosts parameters to reproduce the rejected wire shape.
  test("serializes UGC posts as a Rest.li list", async () => {
    const organization = organizationUrn(123)
    const firstPost = ugcPostUrn(789)
    const secondPost = ugcPostUrn(790)
    const calls = recorder([json({ elements: [] })])
    const client = await createTestClient()

    await client.organizationAnalytics.shares(organization, {
      posts: [firstPost, secondPost],
    })

    const url = calls[0]?.url ?? ""
    expect(url).toContain("ugcPosts=List(urn%3Ali%3AugcPost%3A789,urn%3Ali%3AugcPost%3A790)")
    expect(url).not.toContain("ugcPosts%5B0%5D")
    expect(new URL(url).searchParams.get("ugcPosts")).toBe(`List(${firstPost},${secondPost})`)
  })

  test("serializes shares as a Rest.li list", async () => {
    const organization = organizationUrn(123)
    const firstShare = shareUrn(456)
    const secondShare = shareUrn(457)
    const calls = recorder([json({ elements: [] })])
    const client = await createTestClient()

    await client.organizationAnalytics.shares(organization, {
      posts: [firstShare, secondShare],
    })

    const url = calls[0]?.url ?? ""
    expect(url).toContain("shares=List(urn%3Ali%3Ashare%3A456,urn%3Ali%3Ashare%3A457)")
    expect(url).not.toContain("shares=List%28")
  })

  test("serializes mixed share and UGC post batches independently", async () => {
    const organization = organizationUrn(123)
    const share = shareUrn(456)
    const ugcPost = ugcPostUrn(789)
    const calls = recorder([json({ elements: [] })])
    const client = await createTestClient()

    await client.organizationAnalytics.shares(organization, { posts: [share, ugcPost] })

    const url = calls[0]?.url ?? ""
    expect(url).toContain("shares=List(urn%3Ali%3Ashare%3A456)")
    expect(url).toContain("ugcPosts=List(urn%3Ali%3AugcPost%3A789)")
  })

  test("omits Rest.li post lists when no posts are requested", async () => {
    const calls = recorder([json({ elements: [] })])
    const client = await createTestClient()

    await client.organizationAnalytics.shares(organizationUrn(123), { posts: [] })

    const params = new URL(calls[0]?.url ?? "").searchParams
    expect(params.has("shares")).toBe(false)
    expect(params.has("ugcPosts")).toBe(false)
  })

  test("preserves Rest.li post lists through query tunneling", async () => {
    const share = shareUrn(456)
    const ugcPosts = Array.from({ length: 100 }, (_, index) =>
      ugcPostUrn(`700000000000000${String(index).padStart(4, "0")}`)
    )
    const calls = recorder([json({ elements: [] })])
    const client = await createTestClient()

    await client.organizationAnalytics.shares(organizationUrn(123), {
      posts: [share, ...ugcPosts],
    })

    const body = calls[0]?.body ?? ""
    const serializedUgcPosts = ugcPosts.map((post) => encodeURIComponent(post)).join(",")
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.headers.get("x-http-method-override")).toBe("GET")
    expect(body).toContain("shares=List(urn%3Ali%3Ashare%3A456)")
    expect(body).toContain(`ugcPosts=List(${serializedUgcPosts})`)
    expect(body).not.toContain("List%28")
    expect(body).not.toContain("ugcPosts%5B0%5D")
  })

  test("serializes authenticated-member follower, post, and video analytics", async () => {
    const share = shareUrn(456)
    const ugcPost = ugcPostUrn(789)
    const calls = recorder([
      json({ elements: [{ memberFollowersCount: 1_000 }] }),
      json({ elements: [{ memberFollowersCount: 2 }] }),
      json({ elements: [{ count: 5, metricType: "REACTION", targetEntity: { share } }] }),
      json({ elements: [{ count: 100, metricType: "IMPRESSION" }] }),
      json({ elements: [{ count: 30, metricType: "VIDEO_PLAY", targetEntity: { ugc: ugcPost } }] }),
    ])
    const client = await createTestClient()
    const dateRange = {
      start: { year: 2026, month: 8, day: 1 },
      end: { year: 2026, month: 8, day: 3 },
    } as const

    await client.memberAnalytics.followers()
    await client.memberAnalytics.followerHistory(dateRange)
    await client.memberAnalytics.post({
      entity: share,
      queryType: "REACTION",
      aggregation: "DAILY",
      dateRange,
    })
    await client.memberAnalytics.posts({ queryType: "IMPRESSION", aggregation: "TOTAL" })
    await client.memberAnalytics.video({
      entity: ugcPost,
      queryType: "VIDEO_PLAY",
      aggregation: "DAILY",
      dateRange,
    })

    expect(new URL(calls[0]?.url ?? "").searchParams.get("q")).toBe("me")
    expect(new URL(calls[1]?.url ?? "").searchParams.get("q")).toBe("dateRange")
    expect(new URL(calls[2]?.url ?? "").searchParams.get("entity")).toBe(`(share:${share})`)
    expect(new URL(calls[2]?.url ?? "").searchParams.get("dateRange")).toBe(
      "(start:(year:2026,month:8,day:1),end:(year:2026,month:8,day:3))"
    )
    expect(new URL(calls[3]?.url ?? "").searchParams.get("q")).toBe("me")
    expect(new URL(calls[4]?.url ?? "").searchParams.get("entity")).toBe(`(ugc:${ugcPost})`)
  })

  test("rejects unsupported analytics combinations before making a request", async () => {
    const client = await createTestClient()
    const organization = organizationUrn(123)
    const share = shareUrn(456)

    expect(() =>
      client.organizationAnalytics.pages(organization, {
        timeRange: { start: 1, end: 2 },
        timeGranularityType: "WEEK",
      })
    ).toThrow("DAY or MONTH")
    await expect(
      client.organizationAnalytics.shares(organization, {
        timeIntervals: {
          timeRange: { start: 1, end: 2 },
          timeGranularityType: "DAY",
        },
        posts: [share],
      })
    ).rejects.toThrow("cannot be combined")
    expect(() =>
      client.memberAnalytics.post({
        entity: share,
        queryType: "IMPRESSION",
        aggregation: "DAILY",
      })
    ).toThrow("does not support DAILY")
  })
})
