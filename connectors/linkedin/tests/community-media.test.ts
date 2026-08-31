import { afterEach, describe, expect, test } from "bun:test"
import { createTestClient, json, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin community media", () => {
  test("resolves image, video, and document download metadata from post URNs", async () => {
    const image = "urn:li:image:C4E10AQImage" as const
    const video = "urn:li:video:C4E10AQVideo" as const
    const document = "urn:li:document:D5510AQDocument" as const
    const owner = "urn:li:organization:123" as const
    const calls = recorder([
      json({ id: image, owner, status: "AVAILABLE", downloadUrl: "https://media/image" }),
      json({
        id: video,
        owner,
        status: "AVAILABLE",
        downloadUrl: "https://media/video",
        duration: 32_066,
      }),
      json({ id: document, owner, status: "AVAILABLE", downloadUrl: "https://media/document" }),
    ])
    const client = await createTestClient()

    const resolvedImage = await client.images.get(image)
    const resolvedVideo = await client.videos.get(video)
    const resolvedDocument = await client.documents.get(document)

    expect(resolvedImage.downloadUrl).toBe("https://media/image")
    expect(resolvedVideo.duration).toBe(32_066)
    expect(resolvedDocument.downloadUrl).toBe("https://media/document")
    expect(decodeURIComponent(new URL(calls[0]?.url ?? "").pathname)).toContain(`/images/${image}`)
    expect(decodeURIComponent(new URL(calls[1]?.url ?? "").pathname)).toContain(`/videos/${video}`)
    expect(decodeURIComponent(new URL(calls[2]?.url ?? "").pathname)).toContain(
      `/documents/${document}`
    )
  })
})
