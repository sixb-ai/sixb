import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GoogleApiError } from "../src/errors"
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

  test("list issues GET /files with query and bearer auth", async () => {
    mockFetch(async (input, init) => {
      record(input, init)
      return json({ files: [{ id: "1", name: "Transcript" }] })
    })

    const client = await connect()
    const result = await client.drive.files.list({ q: "'FOLDER' in parents", pageSize: 100 })

    expect(result.files?.[0]?.id).toBe("1")
    expect(requests[0]?.url).toBe(
      "https://www.googleapis.com/drive/v3/files?q=%27FOLDER%27+in+parents&pageSize=100"
    )
    expect(requests[0]?.auth).toBe("Bearer test-token")
  })

  test("listAll walks every page via nextPageToken", async () => {
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
    const files = await collect(client.drive.files.listAll({ pageSize: 2 }))

    expect(files.map((f) => f.id)).toEqual(["1", "2", "3"])
    expect(requests).toHaveLength(2)
    expect(requests[1]?.url).toContain("pageToken=p2")
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

  test("maps a Google error envelope to GoogleApiError", async () => {
    mockFetch(async () =>
      json(
        { error: { code: 403, message: "Insufficient Permission", status: "PERMISSION_DENIED" } },
        { status: 403 }
      )
    )

    const client = await connect()
    const error = (await client.drive.files.list().catch((e) => e)) as GoogleApiError
    expect(error).toBeInstanceOf(GoogleApiError)
    expect(error.status).toBe(403)
    expect(error.message).toContain("Insufficient Permission")
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
