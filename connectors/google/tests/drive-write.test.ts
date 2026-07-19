import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GoogleApiError } from "../src/errors"
import { google } from "../src/google"
import type { GoogleClient } from "../src/index"
import { CONTEXT, json, mockFetch, restoreFetch } from "./helpers"

async function connect(): Promise<GoogleClient> {
  return google({ auth: { token: () => "test-token" } }).connect(CONTEXT)
}

interface RecordedRequest {
  url: string
  method: string
  headers: Headers
  body: Uint8Array | null
  rawBody: unknown
}

async function readBody(body: unknown): Promise<Uint8Array | null> {
  if (body == null) {
    return null
  }
  if (body instanceof Uint8Array) {
    return body
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body)
  }
  if (body instanceof ReadableStream) {
    const chunks: number[] = []
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      for (const byte of value) {
        chunks.push(byte)
      }
    }
    return new Uint8Array(chunks)
  }
  throw new Error(`Unexpected body type in test: ${String(body)}`)
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

afterEach(restoreFetch)

describe("drive.files writes", () => {
  let requests: RecordedRequest[]

  beforeEach(() => {
    requests = []
  })

  function recorder(
    respond: (request: RecordedRequest, index: number) => Response | Promise<Response>
  ): void {
    mockFetch(async (input, init) => {
      const request: RecordedRequest = {
        url: input.toString(),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: await readBody(init?.body ?? null),
        rawBody: init?.body ?? null,
      }
      requests.push(request)
      return respond(request, requests.length - 1)
    })
  }

  test("create without content posts metadata JSON to the API host", async () => {
    recorder(() => json({ id: "new-id", name: "Reports" }))

    const client = await connect()
    const file = await client.drive.files.create({
      name: "Reports",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["parent-1"],
    })

    expect(file.id).toBe("new-id")
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request?.url).toBe("https://www.googleapis.com/drive/v3/files")
    expect(request?.method).toBe("POST")
    expect(request?.headers.get("content-type")).toContain("application/json")
    expect(JSON.parse(new TextDecoder().decode(request?.body ?? undefined))).toEqual({
      name: "Reports",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["parent-1"],
    })
  })

  test("create with small bytes uploads multipart to the upload host", async () => {
    recorder(() => json({ id: "file-1" }))

    const client = await connect()
    const bytes = new TextEncoder().encode("a,b\n1,2\n")
    await client.drive.files.create({
      name: "report.csv",
      parents: ["folder-9"],
      fields: "id, name",
      supportsAllDrives: true,
      content: { body: bytes, mimeType: "text/csv" },
    })

    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request?.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files" +
        "?fields=id%2C+name&supportsAllDrives=true&uploadType=multipart"
    )
    expect(request?.method).toBe("POST")
    expect(request?.headers.get("authorization")).toBe("Bearer test-token")

    const contentType = request?.headers.get("content-type") ?? ""
    expect(contentType).toContain("multipart/related; boundary=")
    const boundary = contentType.split("boundary=")[1] as string

    const text = new TextDecoder().decode(request?.body ?? undefined)
    expect(text).toContain(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`)
    expect(text).toContain('{"name":"report.csv","parents":["folder-9"]}')
    expect(text).toContain(`--${boundary}\r\nContent-Type: text/csv\r\n\r\n`)
    expect(text).toContain("a,b\n1,2\n")
    expect(text.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
  })

  test("create with large bytes runs a chunked resumable session", async () => {
    const sessionUri =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc"
    recorder((_request, index) => {
      if (index === 0) {
        return new Response(null, { status: 200, headers: { location: sessionUri } })
      }
      if (index === 1) {
        return new Response(null, {
          status: 308,
          headers: { range: "bytes=0-8388607" },
        })
      }
      return json({ id: "big-file", size: "10485760" })
    })

    const client = await connect()
    const size = 10 * 1024 * 1024
    const file = await client.drive.files.create({
      name: "big.bin",
      content: { body: new Uint8Array(size), mimeType: "application/octet-stream" },
    })

    expect(file.id).toBe("big-file")
    expect(requests).toHaveLength(3)

    const [initiation, firstChunk, finalChunk] = requests
    expect(initiation?.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"
    )
    expect(initiation?.headers.get("x-upload-content-type")).toBe("application/octet-stream")
    expect(initiation?.headers.get("x-upload-content-length")).toBe(String(size))
    expect(new TextDecoder().decode(initiation?.body ?? undefined)).toBe('{"name":"big.bin"}')

    expect(firstChunk?.url).toBe(sessionUri)
    expect(firstChunk?.method).toBe("PUT")
    expect(firstChunk?.headers.get("content-range")).toBe(`bytes 0-8388607/${size}`)
    expect(firstChunk?.body?.length).toBe(8 * 1024 * 1024)

    expect(finalChunk?.headers.get("content-range")).toBe(`bytes 8388608-${size - 1}/${size}`)
    expect(finalChunk?.body?.length).toBe(2 * 1024 * 1024)
  })

  test("a partially persisted chunk is re-sent from the server's Range offset", async () => {
    recorder((_request, index) => {
      if (index === 0) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://session.test/upload" },
        })
      }
      if (index === 1) {
        // Only half of the first 8 MiB chunk persisted.
        return new Response(null, { status: 308, headers: { range: "bytes=0-4194303" } })
      }
      if (index === 2) {
        return new Response(null, { status: 308, headers: { range: "bytes=0-8388607" } })
      }
      return json({ id: "resumed" })
    })

    const client = await connect()
    const size = 9 * 1024 * 1024
    const file = await client.drive.files.create({
      name: "partial.bin",
      content: { body: new Uint8Array(size) },
    })

    expect(file.id).toBe("resumed")
    expect(requests).toHaveLength(4)
    expect(requests[1]?.headers.get("content-range")).toBe(`bytes 0-8388607/${size}`)
    // Re-send starts where the server left off, not from the chunk start.
    expect(requests[2]?.headers.get("content-range")).toBe(`bytes 4194304-8388607/${size}`)
    expect(requests[2]?.body?.length).toBe(4 * 1024 * 1024)
    expect(requests[3]?.headers.get("content-range")).toBe(`bytes 8388608-${size - 1}/${size}`)
  })

  test("a sized stream is chunked through the resumable path", async () => {
    recorder((_request, index) => {
      if (index === 0) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://session.test/upload" },
        })
      }
      if (index === 1) {
        return new Response(null, { status: 308, headers: { range: "bytes=0-8388607" } })
      }
      return json({ id: "streamed" })
    })

    const chunks = [3, 3, 4].map((mb) => new Uint8Array(mb * 1024 * 1024).fill(1))
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk)
        }
        controller.close()
      },
    })

    const client = await connect()
    const file = await client.drive.files.create({
      name: "blob.bin",
      content: { body: stream, sizeBytes: size },
    })

    expect(file.id).toBe("streamed")
    expect(requests).toHaveLength(3)
    expect(requests[0]?.headers.get("x-upload-content-length")).toBe(String(size))
    expect(requests[1]?.headers.get("content-range")).toBe(`bytes 0-8388607/${size}`)
    expect(requests[2]?.headers.get("content-range")).toBe(`bytes 8388608-${size - 1}/${size}`)
  })

  test("an unsized stream goes as one streaming PUT to the session URI", async () => {
    recorder((_request, index) => {
      if (index === 0) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://session.test/upload" },
        })
      }
      return json({ id: "streamed-unknown" })
    })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5]))
        controller.close()
      },
    })

    const client = await connect()
    const file = await client.drive.files.create({
      name: "mystery.bin",
      content: { body: stream, mimeType: "application/octet-stream" },
    })

    expect(file.id).toBe("streamed-unknown")
    expect(requests).toHaveLength(2)

    const [initiation, put] = requests
    expect(initiation?.headers.get("x-upload-content-length")).toBeNull()
    expect(put?.method).toBe("PUT")
    expect(put?.headers.get("content-range")).toBeNull()
    expect(put?.headers.get("content-type")).toBe("application/octet-stream")
    expect(put?.rawBody).toBeInstanceOf(ReadableStream)
    expect(Array.from(put?.body ?? [])).toEqual([1, 2, 3, 4, 5])
  })

  test("update patches metadata and moves parents via query params", async () => {
    recorder(() => json({ id: "file-7" }))

    const client = await connect()
    await client.drive.files.update("file-7", {
      name: "renamed.csv",
      addParents: "folder-b",
      removeParents: "folder-a",
    })

    const [request] = requests
    expect(request?.url).toBe(
      "https://www.googleapis.com/drive/v3/files/file-7" +
        "?addParents=folder-b&removeParents=folder-a"
    )
    expect(request?.method).toBe("PATCH")
    expect(new TextDecoder().decode(request?.body ?? undefined)).toBe('{"name":"renamed.csv"}')
  })

  test("update with content replaces bytes via PATCH on the upload host", async () => {
    recorder(() => json({ id: "file-7" }))

    const client = await connect()
    await client.drive.files.update("file-7", {
      content: { body: new TextEncoder().encode("v2"), mimeType: "text/plain" },
    })

    const [request] = requests
    expect(request?.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files/file-7?uploadType=multipart"
    )
    expect(request?.method).toBe("PATCH")
    expect(new TextDecoder().decode(request?.body ?? undefined)).toContain("v2")
  })

  test("delete issues DELETE /files/{id}", async () => {
    recorder(() => new Response(null, { status: 204 }))

    const client = await connect()
    await client.drive.files.delete("file-7", { supportsAllDrives: true })

    const [request] = requests
    expect(request?.url).toBe(
      "https://www.googleapis.com/drive/v3/files/file-7?supportsAllDrives=true"
    )
    expect(request?.method).toBe("DELETE")
  })

  test("copy posts metadata to the copy endpoint", async () => {
    recorder(() => json({ id: "copy-1" }))

    const client = await connect()
    const copy = await client.drive.files.copy("file-7", {
      name: "report (copy).csv",
      parents: ["folder-c"],
    })

    expect(copy.id).toBe("copy-1")
    const [request] = requests
    expect(request?.url).toBe("https://www.googleapis.com/drive/v3/files/file-7/copy")
    expect(request?.method).toBe("POST")
    expect(new TextDecoder().decode(request?.body ?? undefined)).toBe(
      '{"name":"report (copy).csv","parents":["folder-c"]}'
    )
  })

  test("a 308 without new acknowledged bytes stalls and fails instead of looping", async () => {
    recorder((_, index) => {
      if (index === 0) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://session.test/upload" },
        })
      }
      // A wedged session: 308 forever, never a Range header.
      return new Response(null, { status: 308 })
    })

    const client = await connect()
    const size = 10 * 1024 * 1024
    const error = await client.drive.files
      .create({ name: "big.bin", content: { body: new Uint8Array(size) } })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("stalled")
    // 1 initiation + 3 stalled attempts of the same chunk — then it gives up.
    expect(requests).toHaveLength(4)
    expect(requests[3]?.headers.get("content-range")).toBe(`bytes 0-8388607/${size}`)
  })

  test("a large Blob is uploaded in slices without being buffered whole", async () => {
    recorder((_, index) => {
      if (index === 0) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://session.test/upload" },
        })
      }
      if (index === 1) {
        return new Response(null, { status: 308, headers: { range: "bytes=0-8388607" } })
      }
      return json({ id: "blob-file" })
    })

    let largestSlice = 0
    const tracked = new (class extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("whole-Blob read: arrayBuffer() must not be called on the source")
      }
      override slice(start = 0, end = this.size): Blob {
        largestSlice = Math.max(largestSlice, end - start)
        return super.slice(start, end)
      }
    })([new Uint8Array(10 * 1024 * 1024).fill(7)])

    const client = await connect()
    const file = await client.drive.files.create({
      name: "big.bin",
      content: { body: tracked, mimeType: "application/octet-stream" },
    })

    expect(file.id).toBe("blob-file")
    expect(largestSlice).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(requests).toHaveLength(3)
    // Byte integrity: every PUT payload is the 7-filled slice it claims to be.
    expect(requests[1]?.body?.every((b) => b === 7)).toBe(true)
    expect(requests[2]?.body?.length).toBe(2 * 1024 * 1024)
    expect(requests[2]?.body?.every((b) => b === 7)).toBe(true)
  })

  test("a small Blob uploads via multipart", async () => {
    recorder(() => json({ id: "blob-small" }))

    const client = await connect()
    await client.drive.files.create({
      name: "tiny.txt",
      content: { body: new Blob(["hello"], { type: "text/plain" }), mimeType: "text/plain" },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain("uploadType=multipart")
    expect(new TextDecoder().decode(requests[0]?.body ?? undefined)).toContain("hello")
  })

  test("update with metadata and large content patches via a resumable session", async () => {
    recorder((_, index) => {
      if (index === 0) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://session.test/upload" },
        })
      }
      if (index === 1) {
        return new Response(null, { status: 308, headers: { range: "bytes=0-8388607" } })
      }
      return json({ id: "file-9" })
    })

    const client = await connect()
    const size = 10 * 1024 * 1024
    await client.drive.files.update("file-9", {
      name: "renamed.bin",
      addParents: "folder-z",
      content: { body: new Uint8Array(size).fill(3) },
    })

    const [initiation] = requests
    expect(initiation?.method).toBe("PATCH")
    expect(initiation?.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files/file-9" +
        "?addParents=folder-z&uploadType=resumable"
    )
    expect(new TextDecoder().decode(initiation?.body ?? undefined)).toBe('{"name":"renamed.bin"}')
    // Byte integrity across the resumable chunk boundary.
    expect(requests[1]?.body?.every((b) => b === 3)).toBe(true)
    expect(requests[2]?.body?.every((b) => b === 3)).toBe(true)
  })

  test("a stream that under-runs its declared sizeBytes fails with an actionable error", async () => {
    recorder((_, index) => {
      if (index === 0) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://session.test/upload" },
        })
      }
      // Google keeps the session open: only 3 of the declared 10 bytes arrived.
      return new Response(null, { status: 308, headers: { range: "bytes=0-2" } })
    })

    const client = await connect()
    const error = await client.drive.files
      .create({
        name: "short.bin",
        content: { body: streamOf([new Uint8Array([1, 2, 3])]), sizeBytes: 10 },
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("sizeBytes")
  })

  test("a stream that over-runs its declared sizeBytes surfaces Google's error", async () => {
    recorder((_, index) => {
      if (index === 0) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://session.test/upload" },
        })
      }
      return json({ error: { code: 400, message: "Invalid range." } }, { status: 400 })
    })

    const client = await connect()
    const error = await client.drive.files
      .create({
        name: "long.bin",
        content: { body: streamOf([new Uint8Array(11)]), sizeBytes: 10 },
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).status).toBe(400)
  })

  test("zero-byte content uploads as one empty multipart request", async () => {
    recorder(() => json({ id: "empty" }))

    const client = await connect()
    await client.drive.files.create({
      name: "empty.txt",
      content: { body: streamOf([]), sizeBytes: 0, mimeType: "text/plain" },
    })

    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request?.url).toContain("uploadType=multipart")
    const text = new TextDecoder().decode(request?.body ?? undefined)
    expect(text).toContain('{"name":"empty.txt"}')
    expect(text).toContain("Content-Type: text/plain")
  })

  test("a 4xx from a mid-session chunk PUT surfaces as GoogleApiError", async () => {
    recorder((_, index) => {
      if (index === 0) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://session.test/upload" },
        })
      }
      return json({ error: { code: 410, message: "Upload session expired." } }, { status: 410 })
    })

    const client = await connect()
    const size = 10 * 1024 * 1024
    const error = await client.drive.files
      .create({ name: "big.bin", content: { body: new Uint8Array(size) } })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).status).toBe(410)
    expect((error as GoogleApiError).message).toContain("Upload session expired.")
  })

  test("a failed resumable initiation surfaces as GoogleApiError", async () => {
    recorder(() =>
      json({ error: { code: 403, message: "Insufficient Permission" } }, { status: 403 })
    )

    const client = await connect()
    const size = 10 * 1024 * 1024
    const error = await client.drive.files
      .create({ name: "big.bin", content: { body: new Uint8Array(size) } })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GoogleApiError)
    expect((error as GoogleApiError).status).toBe(403)
  })

  test("an initiation response without a session URI fails clearly", async () => {
    recorder(() => new Response(null, { status: 200 }))

    const client = await connect()
    const size = 10 * 1024 * 1024
    const error = await client.drive.files
      .create({ name: "big.bin", content: { body: new Uint8Array(size) } })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("no session URI")
  })
})
