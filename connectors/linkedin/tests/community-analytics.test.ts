import { afterEach, describe, expect, test } from "bun:test"
import { organizationUrn, shareUrn, ugcPostUrn } from "../src"
import { createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin community analytics", () => {
  test("serializes organization follower, Page, share, and video analytics", async () => {
    const organization = organizationUrn(123)
    const share = shareUrn(456)
    const ugcPost = ugcPostUrn(789)
    const calls = recorder([
      json({ elements: [{ organizationalEntity: organization, followerGains: {} }] }),
      json({ elements: [{ organization, totalPageStatistics: {} }] }),
      json({ elements: [{ organizationalEntity: organization, totalShareStatistics: {} }] }),
      json({ elements: [{ entity: ugcPost, value: 100 }] }),
    ])
    const client = await createTestClient()

    await client.organizationAnalytics.followers(organization, {
      timeRange: { start: 1_700_000_000_000, end: 1_700_086_400_000 },
      timeGranularityType: "DAY",
    })
    await client.organizationAnalytics.pages(organization)
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
