import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { type CreateInstagramContainerInput, MetaApiError, type MetaClient, meta } from "../src"

const originalFetch = globalThis.fetch
const context = { projectId: "test", connectorId: "meta", signal: new AbortController().signal }
const requests: { url: URL; init: RequestInit }[] = []
let respond = (_url: URL, _init: RequestInit): Response => json({ id: "created" })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function client(options: Partial<Parameters<typeof meta>[0]> = {}): Promise<MetaClient> {
  requests.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url, init: init ?? {} })
    return respond(url, init ?? {})
  }) as typeof fetch
  return meta({ accessToken: "default", ...options }).connect(context)
}

function body(index = 0): Record<string, unknown> {
  return JSON.parse(String(requests[index]?.init.body)) as Record<string, unknown>
}

afterEach(() => {
  globalThis.fetch = originalFetch
  respond = () => json({ id: "created" })
})

describe("Meta publishing contracts", () => {
  test("Instagram creates a container, reads status and publishes distinct IDs with scoped auth", async () => {
    respond = (url) =>
      url.pathname.endsWith("/media_publish")
        ? json({ id: "published" })
        : url.pathname.endsWith("/container")
          ? json({ id: "container", status_code: "FINISHED", status: "Ready" })
          : json({ id: "container" })
    const api = await client()
    const ig = api.instagram("ig", { accessToken: "page-token" })
    expect(
      await ig.media.create({
        image_url: "https://cdn.example/image.jpg",
        caption: "Été #été",
        alt_text: "Photo",
      })
    ).toEqual({ id: "container" })
    expect(
      await api.instagramContainer("container", { accessToken: "page-token" }).get()
    ).toMatchObject({ status_code: "FINISHED" })
    expect(await ig.media.publish({ creation_id: "container" })).toEqual({ id: "published" })
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/v23.0/ig/media",
      "/v23.0/container",
      "/v23.0/ig/media_publish",
    ])
    expect(body()).toEqual({
      image_url: "https://cdn.example/image.jpg",
      caption: "Été #été",
      alt_text: "Photo",
    })
    expect(body(2)).toEqual({ creation_id: "container" })
    for (const request of requests)
      expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer page-token")
    await api.instagram("other").get()
    expect(new Headers(requests[3]?.init.headers).get("authorization")).toBe("Bearer default")
  })

  test("scopes Instagram pagination, insights and published media reads", async () => {
    respond = () => json({ data: [], id: "media", permalink: "https://instagram.com/p/test" })
    const api = await client()
    const ig = api.instagram("ig", { accessToken: "scoped" })
    await ig.media.list()
    await ig.stories.list()
    await ig.insights.get({ metrics: ["reach"] })
    await api
      .instagramMedia("media", { accessToken: "scoped" })
      .insights.get({ metrics: ["reach"] })
    expect(await api.instagramMedia("media", { accessToken: "scoped" }).get()).toMatchObject({
      permalink: "https://instagram.com/p/test",
    })
    for (const request of requests)
      expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer scoped")
  })

  test("preserves carousel order, nested tags and false Reel options", async () => {
    const api = await client()
    const ig = api.instagram("ig")
    await ig.media.create({
      image_url: "https://cdn.example/a.jpg",
      is_carousel_item: true,
      user_tags: [{ username: "name", x: 0, y: 1 }],
    })
    await ig.media.create({
      media_type: "VIDEO",
      is_carousel_item: true,
      video_url: "https://cdn.example/a.mp4",
    })
    await ig.media.create({
      media_type: "CAROUSEL",
      children: ["image", "video"],
      caption: "Album",
      collaborators: ["name"],
    })
    await ig.media.create({
      media_type: "REELS",
      video_url: "https://cdn.example/a.mp4",
      share_to_feed: false,
      thumb_offset: 0,
    })
    expect(body().user_tags).toEqual([{ username: "name", x: 0, y: 1 }])
    expect(body(2).children).toEqual(["image", "video"])
    expect(body(3)).toMatchObject({ share_to_feed: false, thumb_offset: 0 })
  })

  test("returns quota config and status without assuming a fixed limit or terminal state", async () => {
    respond = (url) =>
      url.pathname.endsWith("/content_publishing_limit")
        ? json({ data: [{ quota_usage: 3, config: { quota_total: 75, quota_duration: 86400 } }] })
        : json({
            id: "container",
            status_code: "FUTURE_STATUS",
            copyright_check_status: { status: "in_progress" },
          })
    const api = await client()
    expect(await api.instagram("ig").contentPublishingLimit.get({ since: 1700000000 })).toEqual({
      data: [{ quota_usage: 3, config: { quota_total: 75, quota_duration: 86400 } }],
    })
    expect(requests[0]?.url.searchParams.get("fields")).toBe("quota_usage,config")
    expect(requests[0]?.url.searchParams.get("since")).toBe("1700000000")
    expect(await api.instagramContainer("container").get()).toMatchObject({
      status_code: "FUTURE_STATUS",
    })
  })

  test("Facebook photos preserve optional post_id and serialize files as multipart", async () => {
    respond = () => json({ id: "photo" })
    const api = await client()
    const fb = api.facebook("page", { accessToken: "page-token" })
    expect(await fb.photos.create({ url: "https://cdn.example/a.jpg", published: false })).toEqual({
      id: "photo",
    })
    expect(body()).toEqual({ url: "https://cdn.example/a.jpg", published: false })
    await fb.photos.create({
      source: new Blob(["bytes"], { type: "image/jpeg" }),
      caption: "Caption",
      alt_text_custom: "Alt",
      published: false,
    })
    const form = requests[1]?.init.body as FormData
    expect(form.get("published")).toBe("false")
    expect(form.get("caption")).toBe("Caption")
    expect(await (form.get("source") as Blob).text()).toBe("bytes")
    expect(new Headers(requests[1]?.init.headers).has("content-type")).toBe(false)
    expect(new Headers(requests[1]?.init.headers).get("authorization")).toBe("Bearer page-token")
    await fb.posts.create({
      message: "Album",
      attached_media: [{ media_fbid: "photo" }, { media_fbid: "second" }],
    })
    expect(requests[2]?.url.pathname).toBe("/v23.0/page/feed")
    expect(body(2).attached_media).toEqual([{ media_fbid: "photo" }, { media_fbid: "second" }])
  })

  test("Facebook video inputs use /videos and preserve asynchronous status", async () => {
    const api = await client({ graphVersion: "v25.0" })
    await api
      .facebook("page")
      .videos.create({ file_url: "https://cdn.example/a.mp4", title: "Video", description: "Text" })
    expect(requests[0]?.url.href).toBe("https://graph.facebook.com/v25.0/page/videos")
    expect(body().file_url).toBe("https://cdn.example/a.mp4")
    await api.facebook("page").videos.create({ source: new Blob(["video"]), published: false })
    expect(requests[1]?.init.body).toBeInstanceOf(FormData)
    respond = () =>
      json({
        id: "video",
        status: {
          video_status: "processing",
          uploading_phase: { bytes_transfered: 12 },
          publishing_phase: { status: "not_started" },
        },
      })
    expect(await api.facebookVideo("video", { accessToken: "page-token" }).get()).toMatchObject({
      status: { video_status: "processing", uploading_phase: { bytes_transfered: 12 } },
    })
  })

  test("Facebook Reel start/upload/finish use different contracts and hosts", async () => {
    respond = (url) =>
      url.hostname === "rupload.facebook.com" || requests.length > 1
        ? json({ success: true })
        : json({
            video_id: "video",
            upload_url: "https://rupload.facebook.com/video-upload/v25.0/video",
          })
    const api = await client()
    const reels = api.facebook("page", { accessToken: "page-token" }).reels
    const session = await reels.start()
    await reels.upload(session, { file_url: "https://cdn.example/video.mp4" })
    expect(
      await reels.finish({
        video_id: session.video_id,
        video_state: "PUBLISHED",
        description: "Reel",
      })
    ).toEqual({ success: true })
    expect(body()).toEqual({ upload_phase: "start" })
    expect(new Headers(requests[1]?.init.headers).get("file_url")).toBe(
      "https://cdn.example/video.mp4"
    )
    expect(new Headers(requests[1]?.init.headers).get("authorization")).toBe("OAuth page-token")
    expect(requests[1]?.init.redirect).toBe("error")
    expect(body(2)).toEqual({
      video_id: "video",
      video_state: "PUBLISHED",
      description: "Reel",
      upload_phase: "finish",
    })
  })

  test("Instagram resumable transfer slices the full file at the server's offset", async () => {
    respond = (url) =>
      url.hostname === "rupload.facebook.com"
        ? json({ success: true, message: "Uploaded" })
        : json({
            id: "container",
            uri: "https://rupload.facebook.com/ig-api-upload/v25.0/container",
          })
    const api = await client()
    const created = await api
      .instagram("ig")
      .media.create({ media_type: "REELS", upload_type: "resumable" })
    expect(created.uri).toBeDefined()
    await api
      .instagramContainer(created.id, { accessToken: "scoped" })
      .upload(created.uri!, { file: new Blob(["0123456789"]), offset: 4 })
    expect(await (requests[1]?.init.body as Blob).text()).toBe("456789")
    expect(new Headers(requests[1]?.init.headers).get("file_size")).toBe("10")
    expect(new Headers(requests[1]?.init.headers).get("offset")).toBe("4")
    expect(new Headers(requests[1]?.init.headers).get("authorization")).toBe("OAuth scoped")
  })

  // Regression proof: remove retryable:false in src/publishing.ts; these cases must fail.
  test.each([
    429, 500, 400,
  ])("never replays a mutation on HTTP %i, even with an always-true policy", async (status) => {
    let policyCalls = 0
    respond = () =>
      json({ error: { message: "Rejected", code: 4, error_subcode: 2207051 } }, status)
    const api = await client({
      retry: {
        maxRetries: 2,
        shouldRetry: () => {
          policyCalls++
          return true
        },
        delayMs: () => 0,
      },
    })
    await expect(
      api.instagram("ig").media.publish({ creation_id: "container" })
    ).rejects.toBeInstanceOf(MetaApiError)
    expect(requests).toHaveLength(1)
    expect(policyCalls).toBe(0)
  })

  test("a network timeout is returned without a second publication attempt", async () => {
    respond = () => {
      throw new TypeError("connection lost")
    }
    const api = await client({ retry: { delayMs: () => 0 } })
    await expect(
      api.facebook("page").photos.create({ url: "https://cdn.example/a.jpg" })
    ).rejects.toThrow("connection lost")
    expect(requests).toHaveLength(1)
  })

  test.each([
    { success: false },
    { debug_info: { retriable: false } },
    { error: { message: "failed", code: 100 } },
  ])("retains upload failure envelopes: %j", async (failure) => {
    respond = () => json(failure)
    const api = await client()
    try {
      await api
        .instagramContainer("container")
        .upload("https://rupload.facebook.com/ig-api-upload/container", { file: new Blob(["x"]) })
      throw new Error("Expected upload rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(MetaApiError)
      expect((error as MetaApiError).body).toEqual(failure)
      expect((error as MetaApiError).status).toBe(200)
    }
    expect(requests).toHaveLength(1)
  })

  test("malformed acknowledgements do not become successful publications", async () => {
    respond = () => new Response("not JSON")
    const api = await client()
    await expect(
      api.instagram("ig").media.publish({ creation_id: "container" })
    ).rejects.toMatchObject({ rawBody: "not JSON", status: 200 })
  })

  // Regression proof: remove the observer catch in src/http.ts; this assertion must fail.
  test("observer errors cannot hide a successful write", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const api = await client({
        onResponse: () => {
          throw new Error("telemetry failed")
        },
      })
      expect(await api.instagram("ig").media.publish({ creation_id: "container" })).toEqual({
        id: "created",
      })
      expect(warning).toHaveBeenCalledTimes(1)
      expect(requests).toHaveLength(1)
    } finally {
      warning.mockRestore()
    }
  })

  test.each([
    "https://evil.example/video-upload/video",
    "https://rupload.facebook.com.evil.example/video-upload/video",
    "http://rupload.facebook.com/video-upload/video",
    "https://user:password@rupload.facebook.com/video-upload/video",
    "https://rupload.facebook.com/video-upload/other",
    "https://rupload.facebook.com/ig-api-upload/video",
    "https://rupload.facebook.com:444/video-upload/video",
    "https://rupload.facebook.com/video-upload/video?access_token=bad",
  ])("rejects untrusted upload target %s before sending credentials", async (upload_url) => {
    const api = await client()
    await expect(
      api
        .facebook("page")
        .reels.upload({ video_id: "video", upload_url }, { file_url: "https://cdn.example/a.mp4" })
    ).rejects.toThrow("Invalid Meta upload URI")
    expect(requests).toHaveLength(0)
  })

  test.each([
    { media_type: "REELS", video_url: "https://cdn.example/a.mp4", upload_type: "resumable" },
    { media_type: "VIDEO", video_url: "https://cdn.example/a.mp4" },
    { media_type: "CAROUSEL", children: ["one"] },
    { media_type: "CAROUSEL", children: ["one", "one"] },
    { image_url: "https://cdn.example/a.jpg", is_carousel_item: true, caption: "Wrong location" },
    { image_url: "https://cdn.example/a.jpg", user_tags: [{ username: "name", x: 2, y: 0 }] },
    {
      media_type: "REELS",
      video_url: "https://cdn.example/a.mp4",
      user_tags: [{ username: "name", x: 0, y: 0 }],
    },
    { image_url: "file:///local.jpg" },
    { image_url: "https://cdn.example/a.jpg", alt_text: "a".repeat(1001) },
  ])("rejects invalid Instagram media combinations: %j", async (input) => {
    const api = await client()
    expect(() => api.instagram("ig").media.create(input as CreateInstagramContainerInput)).toThrow(
      "[SixbMeta]"
    )
    expect(requests).toHaveLength(0)
  })

  test("validates Facebook source and scheduling combinations before I/O", async () => {
    const api = await client()
    const fb = api.facebook("page")
    expect(() => fb.photos.create({ url: "https://cdn.example/a.jpg", temporary: true })).toThrow(
      "temporary"
    )
    expect(() =>
      fb.videos.create({ file_url: "https://cdn.example/a.mp4", scheduled_publish_time: 1 })
    ).toThrow("published=false")
    expect(() => fb.posts.create({})).toThrow("requires")
    expect(() =>
      fb.posts.create({ link: "https://example.com", attached_media: [{ media_fbid: "photo" }] })
    ).toThrow("cannot be combined")
    expect(() =>
      fb.reels.finish({
        video_id: "video",
        video_state: "SCHEDULED",
        scheduled_publish_time: Number.NaN,
      })
    ).toThrow("integer")
    expect(requests).toHaveLength(0)
  })

  test("scheduled multi-photo posts require and preserve SCHEDULED content type", async () => {
    const api = await client()
    const input = {
      attached_media: [{ media_fbid: "photo" }],
      published: false,
      scheduled_publish_time: 1800000000,
    }
    expect(() => api.facebook("page").posts.create(input)).toThrow(
      "unpublished_content_type=SCHEDULED"
    )
    expect(requests).toHaveLength(0)
    await api.facebook("page").posts.create({ ...input, unpublished_content_type: "SCHEDULED" })
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      ...input,
      unpublished_content_type: "SCHEDULED",
    })
  })

  test("keeps tasks from Page discovery for permission checks", async () => {
    respond = () => json({ data: [{ id: "page", tasks: ["PROFILE_PLUS_CREATE_CONTENT"] }] })
    const api = await client()
    expect((await api.pages.list({ fields: ["id", "tasks"] })).items[0]?.tasks).toEqual([
      "PROFILE_PLUS_CREATE_CONTENT",
    ])
  })

  test("upload respects runtime cancellation", async () => {
    const abort = new AbortController()
    abort.abort()
    const api = await meta({ accessToken: "default" }).connect({ ...context, signal: abort.signal })
    await expect(
      api
        .instagramContainer("container")
        .upload("https://rupload.facebook.com/ig-api-upload/container", { file: new Blob(["x"]) })
    ).rejects.toThrow()
  })
})

// Compiled by typecheck:tests; deliberately never executed.
function inputContracts(api: MetaClient): void {
  api.instagram("ig").media.create({
    media_type: "REELS",
    video_url: "https://example.com/a.mp4",
    // @ts-expect-error A Reel cannot specify both video delivery modes.
    upload_type: "resumable",
  })
  // @ts-expect-error VIDEO is only valid for carousel children.
  api.instagram("ig").media.create({ media_type: "VIDEO", video_url: "https://example.com/a.mp4" })
  // @ts-expect-error A scheduled Reel requires its timestamp.
  api.facebook("page").reels.finish({ video_id: "video", video_state: "SCHEDULED" })
  // @ts-expect-error Source alternatives are exclusive.
  api.facebook("page").photos.create({ url: "https://example.com/a.jpg", source: new Blob() })
}
void inputContracts
