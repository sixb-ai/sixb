import { afterEach, describe, expect, test } from "bun:test"
import {
  TiktokApiError,
  type TiktokPublishPhotosInput,
  type TiktokPublishVideoInput,
  tiktok,
} from "../src"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const disclosure = { is_brand_organic: true, is_branded_content: false } as const
const video: TiktokPublishVideoInput = {
  video_url: "https://media.example.com/video.mp4?signature=valid",
  post_info: { ...disclosure, caption: "New collection", disable_comment: true },
}
const photos: TiktokPublishPhotosInput = {
  photo_images: ["https://media.example.com/1.jpg", "https://media.example.com/2.webp"],
  photo_cover_index: 1,
  post_info: { ...disclosure, privacy_level: "PUBLIC_TO_EVERYONE", title: "Collection" },
}

function json(data: unknown, status = 200) {
  return Response.json({ code: 0, message: "OK", request_id: "request-1", data }, { status })
}

async function client(invalidate = () => {}) {
  return tiktok({
    api: "organic",
    clientId: "app",
    clientSecret: "secret",
    authorizationUrl: "https://www.tiktok.com/v2/auth/authorize/?scope=video.publish,video.upload",
    // Leave retries enabled: these tests must exercise the production retry policy.
  }).connect({
    projectId: "project",
    connectorId: "tiktok",
    connectionId: "connection",
    account: { id: "creator-1", label: "Brand" },
    signal: new AbortController().signal,
    tokenSource: {
      async get() {
        return { accessToken: "creator-token", invalidate }
      },
    },
  })
}

describe("TikTok Business publishing", () => {
  test("sends video and photo wire contracts with the connected account and token", async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init })
        return json({ share_id: "task-1" })
      },
      { preconnect: originalFetch.preconnect }
    )
    const { publishing } = await client()
    expect(await publishing.publishVideo(video)).toEqual({ share_id: "task-1" })
    expect(await publishing.publishPhotos(photos)).toEqual({ share_id: "task-1" })
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/open_api/v1.3/business/video/publish/",
      "/open_api/v1.3/business/photo/publish/",
    ])
    for (const [index, input] of [video, photos].entries()) {
      const request = requests[index]
      expect(request?.init?.method).toBe("POST")
      expect(new Headers(request?.init?.headers).get("access-token")).toBe("creator-token")
      expect(new Headers(request?.init?.headers).get("content-type")).toContain("application/json")
      expect(JSON.parse(String(request?.init?.body))).toEqual({
        ...input,
        business_id: "creator-1",
      })
    }
  })

  test("does not let an untyped caller override the connected account", async () => {
    let body: unknown
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        return json({ share_id: "task-1" })
      },
      { preconnect: originalFetch.preconnect }
    )
    const { publishing } = await client()
    await publishing.publishVideo({ ...video, business_id: "other" } as TiktokPublishVideoInput)
    expect(body).toEqual({ ...video, business_id: "creator-1" })
  })

  test("sends the distinct video and photo draft fields without invented defaults", async () => {
    const bodies: unknown[] = []
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return json({ share_id: "draft-1" })
      },
      { preconnect: originalFetch.preconnect }
    )
    const { publishing } = await client()
    await publishing.publishVideo({
      video_url: video.video_url,
      post_info: { upload_to_draft: true },
    })
    await publishing.publishPhotos({
      photo_images: photos.photo_images,
      post_info: { is_draft: true, title: "Draft", caption: "Editable" },
    })
    expect(bodies).toEqual([
      {
        business_id: "creator-1",
        video_url: video.video_url,
        post_info: { upload_to_draft: true },
      },
      {
        business_id: "creator-1",
        photo_images: photos.photo_images,
        post_info: { is_draft: true, title: "Draft", caption: "Editable" },
      },
    ])
  })

  test("reads settings and preserves asynchronous status, failure and string IDs", async () => {
    const settings = {
      privacy_level_options: ["SELF_ONLY"],
      comment_disabled: true,
      duet_disabled: true,
      stitch_disabled: true,
      max_video_post_duration_sec: 60,
    } as const
    const statuses = [
      { status: "PROCESSING_DOWNLOAD" },
      { status: "SEND_TO_USER_INBOX" },
      { status: "PUBLISH_COMPLETE" },
      { status: "PUBLISH_COMPLETE", post_ids: ["9007199254740993123"] },
      { status: "FAILED", reason: "frame_rate_check_failed" },
    ]
    const urls: URL[] = []
    let index = 0
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(new URL(String(input)))
        expect(init?.method).toBe("GET")
        return json([settings, ...statuses][index++])
      },
      { preconnect: originalFetch.preconnect }
    )
    const { publishing } = await client()
    expect(await publishing.getSettings()).toEqual(settings)
    for (const response of statuses) {
      expect(await publishing.getStatus("task~1&2")).toEqual(response)
    }
    expect(urls[0]?.pathname).toEndWith("/business/video/settings/")
    for (const url of urls) expect(url.searchParams.get("business_id")).toBe("creator-1")
    for (const url of urls.slice(1)) {
      expect(url.pathname).toEndWith("/business/publish/status/")
      expect(url.searchParams.get("publish_id")).toBe("task~1&2")
    }
  })

  // Regression check: set idempotent/retryable to true in TiktokHttp to make the
  // network/503/429 cases fail; restore unconditional auth continue for the token case.
  test.each([
    "network",
    "503",
    "429",
    "token",
  ])("never replays a publication after %s", async (failure) => {
    for (const media of ["video", "photos"] as const) {
      let calls = 0
      let invalidations = 0
      globalThis.fetch = Object.assign(
        async () => {
          calls++
          // A second attempt succeeds so accidental retries fail fast instead of sleeping.
          if (calls > 1) return json({ share_id: "duplicate" })
          if (failure === "network") throw new TypeError("Connection lost")
          if (failure === "token")
            return Response.json({
              code: 40001,
              message: "Invalid access token",
              request_id: "rejected",
            })
          return new Response("temporary error", {
            status: Number(failure),
            headers: { "retry-after": "0" },
          })
        },
        { preconnect: originalFetch.preconnect }
      )
      const { publishing } = await client(() => {
        invalidations++
      })
      await expect(
        media === "video" ? publishing.publishVideo(video) : publishing.publishPhotos(photos)
      ).rejects.toThrow()
      expect(calls).toBe(1)
      expect(invalidations).toBe(failure === "token" ? 1 : 0)
    }
  })

  // Regression check: require `data` again in parseEnvelope; the provider-code assertion fails.
  test("preserves provider errors and rejects missing task IDs", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({ code: 40002, message: "Permission denied", request_id: "denied" }),
      { preconnect: originalFetch.preconnect }
    )
    const { publishing } = await client()
    try {
      await publishing.publishVideo(video)
      throw new Error("Expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(TiktokApiError)
      expect((error as TiktokApiError).requestId).toBe("denied")
      expect((error as TiktokApiError).code).toBe(40002)
    }
    globalThis.fetch = Object.assign(async () => json({}), { preconnect: originalFetch.preconnect })
    await expect(publishing.publishPhotos(photos)).rejects.toThrow("share_id")
  })

  test("keeps reads retryable and refreshes a rejected token without data", async () => {
    let calls = 0
    let invalidations = 0
    globalThis.fetch = Object.assign(
      async () => {
        calls++
        if (calls === 1)
          return new Response("Busy", { status: 503, headers: { "retry-after": "0" } })
        if (calls === 2)
          return Response.json({
            code: 40001,
            message: "Access token expired",
            request_id: "expired",
          })
        return json({ status: "PROCESSING_DOWNLOAD" })
      },
      { preconnect: originalFetch.preconnect }
    )
    const { publishing } = await client(() => {
      invalidations++
    })
    expect(await publishing.getStatus("task-1")).toEqual({ status: "PROCESSING_DOWNLOAD" })
    expect(calls).toBe(3)
    expect(invalidations).toBe(1)
  })

  test("validates inputs before any request, including UTF-16 and ignored draft metadata", async () => {
    let calls = 0
    globalThis.fetch = Object.assign(
      async () => {
        calls++
        return json({ share_id: "task" })
      },
      { preconnect: originalFetch.preconnect }
    )
    const { publishing } = await client()
    const badVideos: unknown[] = [
      { ...video, video_url: "file:///tmp/video.mp4" },
      { ...video, video_url: "https://user:secret@example.com/video" },
      { ...video, custom_thumbnail_url: "relative.jpg" },
      { ...video, post_info: undefined },
      { ...video, post_info: {} },
      { ...video, post_info: { ...disclosure, caption: "😀".repeat(1101) } },
      { ...video, post_info: { ...disclosure, thumbnail_offset: -1 } },
      { ...video, post_info: { ...disclosure, thumbnail_offset: 1.5 } },
      { ...video, post_info: { ...disclosure, disable_comment: "false" } },
      { ...video, post_info: { upload_to_draft: true, caption: "ignored" } },
      { ...video, post_info: { ...disclosure, privacy_level: "SELF_ONLY" } },
      { ...video, post_info: { ...disclosure, is_draft: true } },
    ]
    for (const input of badVideos)
      await expect(publishing.publishVideo(input as TiktokPublishVideoInput)).rejects.toThrow()
    const badPhotos: unknown[] = [
      { ...photos, photo_images: [] },
      { ...photos, photo_images: Array(36).fill("https://example.com/1.jpg") },
      { ...photos, photo_images: ["data:image/jpeg;base64,foo"] },
      { ...photos, photo_cover_index: 2 },
      { ...photos, photo_cover_index: 0.5 },
      { ...photos, post_info: { ...disclosure } },
      { ...photos, post_info: { ...disclosure, privacy_level: "PUBLIC" } },
      { ...photos, post_info: { ...photos.post_info, title: "😀".repeat(46) } },
      { ...photos, post_info: { ...photos.post_info, caption: "😀".repeat(2001) } },
      { ...photos, post_info: { is_draft: true, auto_add_music: true } },
      { ...photos, post_info: { ...photos.post_info, upload_to_draft: true } },
    ]
    for (const input of badPhotos)
      await expect(publishing.publishPhotos(input as TiktokPublishPhotosInput)).rejects.toThrow()
    await expect(publishing.getStatus(" ")).rejects.toThrow("publishId")
    expect(calls).toBe(0)
    await publishing.publishVideo({
      ...video,
      post_info: { ...disclosure, caption: "😀".repeat(1100), thumbnail_offset: 0 },
    })
    await publishing.publishPhotos({
      ...photos,
      photo_images: Array(35).fill("https://example.com/1.webp"),
      photo_cover_index: 34,
      post_info: {
        ...disclosure,
        privacy_level: "SELF_ONLY",
        title: "😀".repeat(45),
        caption: "😀".repeat(2000),
      },
    })
    expect(calls).toBe(2)
  })
})
