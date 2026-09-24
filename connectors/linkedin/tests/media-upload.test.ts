import { afterEach, describe, expect, test } from "bun:test"
import {
  escapeLinkedinText,
  type LinkedinCreatePostInput,
  type LinkedinImageUploadSession,
  LinkedinMediaUploadError,
  type LinkedinVideoUploadSession,
  organizationUrn,
} from "../src"
import {
  createTestClient,
  empty,
  json,
  mockFetch,
  recorder,
  TOKEN,
  testTokenSource,
} from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const owner = organizationUrn(123)
const image = "urn:li:image:photo"
const video = "urn:li:video:movie"
const expires = 4_102_444_800_000
const imageSession: LinkedinImageUploadSession = {
  image,
  uploadUrl: "https://www.linkedin.com/dms-uploads/image?signature=test",
  uploadUrlExpiresAt: expires,
}
const videoSession: LinkedinVideoUploadSession = {
  video,
  uploadUrlsExpireAt: expires,
  uploadToken: "",
  uploadInstructions: [
    { firstByte: 0, lastByte: 2, uploadUrl: "https://www.linkedin.com/dms-uploads/part1" },
    { firstByte: 3, lastByte: 4, uploadUrl: "https://www.linkedin.com/dms-uploads/part2" },
  ],
}
const post: LinkedinCreatePostInput = {
  author: owner,
  commentary: "Hello",
  visibility: "PUBLIC",
  lifecycleState: "PUBLISHED",
  distribution: { feedDistribution: "MAIN_FEED" },
}

describe("linkedin media publishing", () => {
  test("uploads image bytes with fresh OAuth, polls processing, then publishes its typed URN", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    let reads = 0
    let accessToken = "initial-test-token"
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes("initializeUpload")) {
        expect(JSON.parse(String(init?.body))).toEqual({ initializeUploadRequest: { owner } })
        accessToken = "refreshed-test-token"
        return json({ value: imageSession })
      }
      if (String(url) === imageSession.uploadUrl) {
        expect(init?.body).toBeInstanceOf(Blob)
        expect(await new Response(init?.body).text()).toBe("image-bytes")
        const headers = new Headers(init?.headers)
        expect(headers.get("authorization")).toBe("Bearer refreshed-test-token")
        expect(headers.get("content-type")).toBe("application/octet-stream")
        expect(headers.has("linkedin-version")).toBe(false)
        expect(init?.redirect).toBe("error")
        return empty(201)
      }
      if (init?.method === "POST") return empty(201, { "x-restli-id": "urn:li:ugcPost:456" })
      return json({ id: image, owner, status: reads++ === 0 ? "PROCESSING" : "AVAILABLE" })
    })
    const client = await createTestClient(
      {},
      testTokenSource(() => accessToken)
    )
    const id = await client.images.upload(
      { owner, file: new Blob(["image-bytes"]) },
      { pollIntervalMs: 1 }
    )
    expect(id).toBe(image)
    const created = await client.posts.create({
      ...post,
      content: { media: { id, altText: "Our photo" } },
    })
    await client.posts.get(created.id, "AUTHOR") // The create output is directly accepted by the typed read API.
    expect(calls).toHaveLength(6)
    expect(new Headers(calls[0]?.init?.headers).get("linkedin-version")).toBe("202608")
    expect(JSON.parse(String(calls[4]?.init?.body)).content).toEqual({
      media: { id: image, altText: "Our photo" },
    })
  })

  test("uploads inclusive server-defined video slices without OAuth and finalizes ordered ETags", async () => {
    const calls: string[] = []
    mockFetch(async (url, init) => {
      calls.push(String(url))
      if (String(url).includes("initializeUpload")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          initializeUploadRequest: {
            owner,
            fileSizeBytes: 5,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        })
        return json({ value: videoSession })
      }
      if (init?.method === "PUT") {
        // Regression guard: change slice's end from lastByte + 1 to lastByte and this test fails.
        const first = String(url).endsWith("part1")
        expect(await new Response(init.body).text()).toBe(first ? "abc" : "de")
        expect(new Headers(init.headers).has("authorization")).toBe(false)
        expect(new Headers(init.headers).has("x-restli-protocol-version")).toBe(false)
        return empty(200, { etag: first ? '"part-one"' : "/opaque/part-two" })
      }
      if (String(url).includes("finalizeUpload")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          finalizeUploadRequest: {
            video,
            uploadToken: "",
            uploadedPartIds: ["part-one", "/opaque/part-two"],
          },
        })
        return empty(200)
      }
      return json({ id: video, owner, status: "AVAILABLE" })
    })
    const client = await createTestClient()
    expect(await client.videos.upload({ owner, file: new Blob(["abcde"]) })).toBe(video)
    expect(calls).toHaveLength(5)
  })

  test("allows upload without status reads for write-only grants", async () => {
    const calls = recorder([json({ value: imageSession }), empty(201)])
    const client = await createTestClient()
    expect(
      await client.images.upload(
        { owner, file: new Blob(["photo"]) },
        { waitUntilAvailable: false }
      )
    ).toBe(image)
    expect(calls).toHaveLength(2)
  })

  test("clips the final reserved range at EOF, as in LinkedIn's initialization example", async () => {
    const calls: string[] = []
    mockFetch(async (url, init) => {
      calls.push(String(url))
      if (String(url).includes("initializeUpload")) {
        return json({
          value: {
            ...videoSession,
            uploadInstructions: [
              { firstByte: 0, lastByte: 4_194_303, uploadUrl: imageSession.uploadUrl },
            ],
          },
        })
      }
      if (init?.method === "PUT") {
        expect(await new Response(init.body).text()).toBe("abcde")
        return empty(200, { etag: "part" })
      }
      return empty(200)
    })
    const client = await createTestClient()
    expect(
      await client.videos.upload(
        { owner, file: new Blob(["abcde"]) },
        { waitUntilAvailable: false }
      )
    ).toBe(video)
    expect(calls).toHaveLength(3)
  })

  test("exposes low-level initialization and preserves optional wire metadata", async () => {
    const metadata = {
      associatedAccount: "urn:li:sponsoredAccount:123",
      assetName: "Collection",
    } as const
    const input = {
      owner,
      fileSizeBytes: 5,
      uploadCaptions: true,
      uploadThumbnail: true,
      mediaLibraryMetadata: metadata,
      templateName: "Template",
      linkbackContext: "https://example.com/template",
    }
    const session = {
      ...videoSession,
      captionsUploadUrl: imageSession.uploadUrl,
      thumbnailUploadUrl: imageSession.uploadUrl,
    }
    const calls = recorder([json({ value: imageSession }), json({ value: session })])
    const client = await createTestClient()
    expect(await client.images.initializeUpload({ owner, mediaLibraryMetadata: metadata })).toEqual(
      imageSession
    )
    expect(await client.videos.initializeUpload(input)).toEqual(session)
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      initializeUploadRequest: { owner, mediaLibraryMetadata: metadata },
    })
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ initializeUploadRequest: input })
  })

  test("rejects malformed initialization responses without leaking their URLs", async () => {
    const client = await createTestClient()
    for (const value of [{}, { value: { image: "bad", uploadUrl: "signed-secret" } }]) {
      recorder([json(value)])
      await expect(client.images.initializeUpload({ owner })).rejects.toThrow(
        "Expected a LinkedIn image URN"
      )
    }
    for (const value of [
      {},
      { value: { ...videoSession, uploadInstructions: null } },
      { value: { ...videoSession, uploadToken: null } },
    ]) {
      recorder([json(value)])
      await expect(
        client.videos.initializeUpload({ owner, fileSizeBytes: 5 })
      ).rejects.toBeInstanceOf(LinkedinMediaUploadError)
    }
  })

  test("does not retry failed initialization or finalization by default", async () => {
    const client = await createTestClient()
    const initCalls = recorder([empty(500)])
    await expect(client.images.initializeUpload({ owner })).rejects.toThrow("500")
    expect(initCalls).toHaveLength(1)
    const finalizeCalls = recorder([empty(500)])
    await expect(
      client.videos.finalizeUpload({ video, uploadToken: "", uploadedPartIds: ["part"] })
    ).rejects.toThrow("500")
    expect(finalizeCalls).toHaveLength(1)
  })

  test("rejects empty input and invalid waits before initializing an asset", async () => {
    const calls = recorder([])
    const client = await createTestClient()
    await expect(client.images.upload({ owner, file: new Blob() })).rejects.toThrow("non-empty")
    await expect(
      client.videos.upload({ owner, file: new Blob(["x"]) }, { timeoutMs: 0 })
    ).rejects.toThrow("durations")
    await expect(client.videos.initializeUpload({ owner, fileSizeBytes: -1 })).rejects.toThrow(
      "fileSizeBytes"
    )
    expect(calls).toHaveLength(0)
  })

  test("rejects untrusted, insecure and credential-bearing upload URLs without sending tokens", async () => {
    const client = await createTestClient()
    const calls = recorder([])
    for (const uploadUrl of [
      "https://evil.example/upload",
      "https://www.linkedin.com.evil.example/upload",
      "http://www.linkedin.com/upload",
      "https://user@www.linkedin.com/upload",
      "https://www.linkedin.com:8443/upload",
      "not a URL",
    ]) {
      await expect(
        client.images.uploadContent({ ...imageSession, uploadUrl }, new Blob(["x"]))
      ).rejects.toBeInstanceOf(LinkedinMediaUploadError)
    }
    expect(calls).toHaveLength(0)
  })

  test("rejects expired sessions and malformed video ranges before transferring", async () => {
    const client = await createTestClient()
    const calls = recorder([])
    await expect(
      client.images.uploadContent({ ...imageSession, uploadUrlExpiresAt: 1 }, new Blob(["x"]))
    ).rejects.toThrow("expired")
    expect(calls).toHaveLength(0)
    for (const ranges of [
      [],
      [{ firstByte: 1, lastByte: 4 }],
      [{ firstByte: 0, lastByte: 3 }],
      [
        { firstByte: 0, lastByte: 2 },
        { firstByte: 2, lastByte: 4 },
      ],
    ]) {
      const requests = recorder([
        json({
          value: {
            ...videoSession,
            uploadInstructions: ranges.map((range) => ({
              ...range,
              uploadUrl: imageSession.uploadUrl,
            })),
          },
        }),
      ])
      await expect(client.videos.upload({ owner, file: new Blob(["abcde"]) })).rejects.toThrow(
        "ranges"
      )
      expect(requests).toHaveLength(1)
    }
  })

  test("stops before finalization when a part has no ETag or the transfer fails", async () => {
    const client = await createTestClient({
      retry: { maxRetries: 3, shouldRetry: ({ response }) => !response?.ok, delayMs: () => 0 },
    })
    for (const response of [empty(200), empty(401), empty(500)]) {
      const calls = recorder([json({ value: videoSession }), response])
      await expect(
        client.videos.upload({ owner, file: new Blob(["abcde"]) })
      ).rejects.toBeInstanceOf(LinkedinMediaUploadError)
      expect(calls).toHaveLength(2)
    }
  })

  test("does not invalidate OAuth or expose signed URL/body on upload failures", async () => {
    let invalidations = 0
    const client = await createTestClient(
      {},
      testTokenSource(
        () => TOKEN,
        () => {
          invalidations++
        }
      )
    )
    recorder([new Response("secret-response", { status: 401 })])
    try {
      await client.images.uploadContent(imageSession, new Blob(["x"]))
      throw new Error("Expected upload failure")
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedinMediaUploadError)
      expect(String(error)).not.toContain("signature")
      expect(String(error)).not.toContain("secret-response")
      expect(error).toHaveProperty("status", 401)
    }
    mockFetch(async () => {
      throw new Error(`fetch failed: ${imageSession.uploadUrl}`)
    })
    await expect(client.images.uploadContent(imageSession, new Blob(["x"]))).rejects.toThrow(
      "not retried"
    )
    expect(invalidations).toBe(0)
  })

  test("reports processing failure and bounds/cancels polling", async () => {
    const client = await createTestClient({ retry: { maxRetries: 0 } })
    recorder([
      json({
        id: video,
        owner,
        status: "PROCESSING_FAILED",
        processingFailureReason: "Unsupported format",
      }),
    ])
    await expect(client.videos.waitUntilAvailable(video)).rejects.toThrow(
      `Processing failed for ${video}`
    )
    recorder(() => json({ id: image, owner, status: "PROCESSING" }))
    await expect(
      client.images.waitUntilAvailable(image, { timeoutMs: 10, pollIntervalMs: 2 })
    ).rejects.toThrow("Timed out")
    const controller = new AbortController()
    const pending = client.images.waitUntilAvailable(image, {
      signal: controller.signal,
      pollIntervalMs: 1000,
    })
    controller.abort(new Error("Stopped by caller"))
    await expect(pending).rejects.toThrow("Stopped by caller")
  })

  test("bounded wait aborts an in-flight status request", async () => {
    let signal: AbortSignal | null | undefined
    mockFetch(async (_, init) => {
      signal = init?.signal
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true })
      })
    })
    const client = await createTestClient({ retry: { maxRetries: 0 } })
    await expect(client.images.waitUntilAvailable(image, { timeoutMs: 10 })).rejects.toThrow(
      "Timed out"
    )
    expect(signal?.aborted).toBe(true)
  })

  test("cancels binary transfers and never proceeds to finalize", async () => {
    const controller = new AbortController()
    let calls = 0
    mockFetch(async (_, init) => {
      calls++
      if (init?.method !== "PUT") return json({ value: videoSession })
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        controller.abort()
      })
    })
    const client = await createTestClient()
    await expect(
      client.videos.upload({ owner, file: new Blob(["abcde"]) }, { signal: controller.signal })
    ).rejects.toThrow("cancelled")
    expect(calls).toBe(2)
  })

  test("publishes single video and multi-image wire content unchanged", async () => {
    const calls = recorder([
      empty(201, { "x-restli-id": "urn:li:share:1" }),
      empty(201, { "x-restli-id": "urn:li:ugcPost:2" }),
    ])
    const client = await createTestClient()
    const videoContent = { media: { id: video, title: "Video" } } as const
    const multiContent = {
      multiImage: { images: [{ id: image, altText: "One" }, { id: "urn:li:image:second" }] },
    } as const
    await client.posts.create({ ...post, content: videoContent })
    await client.posts.create({ ...post, content: multiContent })
    expect(JSON.parse(calls[0]?.body ?? "{}").content).toEqual(videoContent)
    expect(JSON.parse(calls[1]?.body ?? "{}").content).toEqual(multiContent)
    for (const count of [0, 1, 21]) {
      await expect(
        client.posts.create({
          ...post,
          content: { multiImage: { images: Array.from({ length: count }, () => ({ id: image })) } },
        })
      ).rejects.toThrow("between 2 and 20")
    }
    expect(calls).toHaveLength(2)
  })

  test("rejects invalid created post identifiers without retrying creation", async () => {
    const client = await createTestClient()
    const calls = recorder([empty(201, { "x-restli-id": "123" })])
    await expect(client.posts.create(post)).rejects.toThrow("valid share or ugcPost URN")
    expect(calls).toHaveLength(1)
  })

  test("escapes every little reserved character without changing Unicode or newlines", () => {
    const reserved = "|{}@[]()<>#\\*_~"
    expect(escapeLinkedinText(reserved)).toBe([...reserved].map((char) => `\\${char}`).join(""))
    expect(escapeLinkedinText("Café 😀\nNew collection")).toBe("Café 😀\nNew collection")
  })
})
