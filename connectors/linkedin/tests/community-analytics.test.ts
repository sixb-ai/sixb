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
  test("serializes organization follower, page, share, and video analytics", async () => {
    const organization = organizationUrn(123)
    const share = shareUrn(456)
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
      json({ elements: [{ organizationalEntity: organization, totalShareStatistics: {} }] }),
      json({ elements: [{ entity: ugcPost, value: 100 }] }),
    ])
    const client = await createTestClient()

    const followers = await client.organizationAnalytics.followers(organization, {
      timeRange: { start: 1_700_000_000_000, end: 1_700_086_400_000 },
      timeGranularityType: "DAY",
    })
    const pages = await client.organizationAnalytics.pages(organization)
    await client.organizationAnalytics.shares(organization, { posts: [share, ugcPost] })
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
    expect(new URL(calls[2]?.url ?? "").searchParams.get("shares")).toBe(`List(${share})`)
    expect(new URL(calls[2]?.url ?? "").searchParams.get("ugcPosts[0]")).toBe(ugcPost)
    expect(new URL(calls[3]?.url ?? "").searchParams.get("type")).toBe(
      "TIME_WATCHED_FOR_VIDEO_VIEWS"
    )
    expect(new URL(calls[3]?.url ?? "").searchParams.get("timeRange")).toBe(
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
