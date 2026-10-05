import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

afterEach(() => {
  setSystemTime()
})

async function createDownloadApi() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const createHost = (id: string) =>
    new SixbHost({
      id,
      ontology: [],
      broker: new InMemoryBroker(),
      storage,
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage,
      queues: new InMemoryQueues(),
      // Auth is on, and no request below carries a session: the token alone must suffice.
      auth: { id: "test", kind: "dev" },
    })
  const host = createHost("test-project")
  // The server records its public origin on the host; download URLs name it.
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const sixb = createTestSixb(host)
  const photo = await sixb.blobs.put({
    body: new TextEncoder().encode("jpeg bytes"),
    fileName: "photo.jpg",
    mediaType: "image/jpeg",
  })
  return { app, sixb, photo, createHost }
}

/** The API under test answers on localhost; download URLs name its public origin. */
function fetchPath(app: ReturnType<typeof createSixbApi>, url: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${new URL(url).pathname}`, init))
}

describe("file download routes", () => {
  test("serves the file to a caller without a session, at the server's public origin", async () => {
    const { app, sixb, photo } = await createDownloadApi()
    const { url } = await sixb.blobs.createDownloadUrl(photo)

    const response = await fetchPath(app, url)

    expect(url.startsWith("http://api.localhost/api/files/downloads/")).toBe(true)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/jpeg")
    expect(response.headers.get("content-length")).toBe("10")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await response.text()).toBe("jpeg bytes")
  })

  test("answers HEAD and byte ranges, which media fetchers rely on", async () => {
    const { app, sixb, photo } = await createDownloadApi()
    const { url } = await sixb.blobs.createDownloadUrl(photo)

    const head = await fetchPath(app, url, { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe("10")
    expect(await head.text()).toBe("")

    const partial = await fetchPath(app, url, { headers: { range: "bytes=0-3" } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get("content-range")).toBe("bytes 0-3/10")
    expect(await partial.text()).toBe("jpeg")
  })

  test("answers 404 to an expired, revoked, forged, or foreign token", async () => {
    const { app, sixb, photo, createHost } = await createDownloadApi()
    setSystemTime(new Date(Date.now() - 2 * 60 * 60 * 1000))
    const expired = await sixb.blobs.createDownloadUrl(photo)
    setSystemTime()
    const revoked = await sixb.blobs.createDownloadUrl(photo)
    await sixb.blobs.revokeDownloadUrl(revoked.id)
    // Same storage, another project: the grant exists but is not this API's to serve.
    const otherHost = createHost("other-project")
    new SixbServer({ host: otherHost, quiet: true, browser: createTestBrowserPolicy() })
    const foreign = await createTestSixb(otherHost).blobs.createDownloadUrl(photo)
    const valid = await sixb.blobs.createDownloadUrl(photo)
    const forged = valid.url.replace(/.$/, (last) => (last === "A" ? "B" : "A"))

    for (const url of [expired.url, revoked.url, foreign.url, forged]) {
      const response = await fetchPath(app, url)
      expect(response.status, url).toBe(404)
      expect(await response.json()).toEqual({ error: "File not found" })
    }
    expect((await fetchPath(app, valid.url)).status).toBe(200)
  })
})
