import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { google } from "../src/google"
import type { GoogleClient } from "../src/index"
import { CONTEXT, collect, json, mockFetch, restoreFetch } from "./helpers"

async function connect(): Promise<GoogleClient> {
  return google({ auth: { token: () => "test-token" } }).connect(CONTEXT)
}

afterEach(restoreFetch)

describe("drive.files", () => {
  let requests: Array<{ url: string; auth: string | null }>

  beforeEach(() => {
    requests = []
  })

  function record(input: RequestInfo | URL, init?: RequestInit): void {
    requests.push({
      url: input.toString(),
      auth: new Headers(init?.headers).get("authorization"),
    })
  }

  test("list and listAll issue GET /files with query and bearer auth on every page", async () => {
    const pages = [
      { files: [{ id: "1" }, { id: "2" }], nextPageToken: "p2" },
      { files: [{ id: "3" }] },
    ]
    let call = 0
    mockFetch(async (input, init) => {
      record(input, init)
      return json(pages[call++])
    })

    const client = await connect()
    const files = await collect(
      client.drive.files.listAll({ q: "'FOLDER' in parents", pageSize: 2 })
    )

    expect(files.map((f) => f.id)).toEqual(["1", "2", "3"])
    expect(requests.map((request) => request.url)).toEqual([
      "https://www.googleapis.com/drive/v3/files?q=%27FOLDER%27+in+parents&pageSize=2",
      "https://www.googleapis.com/drive/v3/files?q=%27FOLDER%27+in+parents&pageSize=2&pageToken=p2",
    ])
    expect(requests.map((request) => request.auth)).toEqual([
      "Bearer test-token",
      "Bearer test-token",
    ])
  })

  test("get fetches a single file by id", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ id: "abc", name: "Doc" })
    })

    const client = await connect()
    const file = await client.drive.files.get("abc", { fields: "id, name" })

    expect(file.name).toBe("Doc")
    expect(requests[0]?.url).toBe("https://www.googleapis.com/drive/v3/files/abc?fields=id%2C+name")
  })

  test("download requests alt=media with Drive options and returns raw file bytes", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return new Response(Uint8Array.from([0, 127, 255]), {
        headers: { "content-type": "application/octet-stream" },
      })
    })

    const client = await connect()
    const bytes = await client.drive.files.download("stored/file", {
      supportsAllDrives: true,
      acknowledgeAbuse: true,
    })

    expect(Array.from(bytes)).toEqual([0, 127, 255])
    expect(requests[0]?.url).toBe(
      "https://www.googleapis.com/drive/v3/files/stored%2Ffile" +
        "?alt=media&supportsAllDrives=true&acknowledgeAbuse=true"
    )
  })

  test("export returns raw bytes from the export endpoint", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return new Response("Speaker: hello world", {
        headers: { "content-type": "text/plain" },
      })
    })

    const client = await connect()
    const bytes = await client.drive.files.export("doc-id", "text/plain")

    expect(new TextDecoder().decode(bytes)).toBe("Speaker: hello world")
    expect(requests[0]?.url).toBe(
      "https://www.googleapis.com/drive/v3/files/doc-id/export?mimeType=text%2Fplain"
    )
  })
})

describe("drive.changes", () => {
  test("getStartPageToken and paginated listAll", async () => {
    const responses = [
      { startPageToken: "100" },
      { changes: [{ fileId: "a" }], nextPageToken: "101" },
      { changes: [{ fileId: "b" }], newStartPageToken: "200" },
    ]
    let call = 0
    mockFetch(async () => json(responses[call++]))

    const client = await connect()
    const start = await client.drive.changes.getStartPageToken()
    expect(start.startPageToken).toBe("100")

    const changes = await collect(client.drive.changes.listAll({ pageToken: "100" }))
    expect(changes.map((c) => c.fileId)).toEqual(["a", "b"])
  })
})
