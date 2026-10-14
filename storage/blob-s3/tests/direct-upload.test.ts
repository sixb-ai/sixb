import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { computeBlobDigest } from "@sixb/core/blob-storage/server"
import { S3BlobStorage } from "../src/s3-blob-storage"

const bytes = new TextEncoder().encode("%PDF-1.7\nverified PDF bytes\n%%EOF")
const digest = computeBlobDigest(bytes)
const finalKey = `sixb/blobs/sha256/${digest.slice("sha256:".length)}`

// Exercise the real AWS SDK and HTTP serialization, including COPY and GET, rather than mock
// completeUpload. This endpoint intentionally accepts PUT without retaining checksum metadata,
// reproducing the Spaces failure. Reverting completeUpload must break the success/race tests.
function fixture(
  options: {
    checksum?: "valid" | "wrong"
    getBody?: Uint8Array
    failure?: "read" | "promote" | "cleanup" | "head"
    overwrite?: "before-snapshot" | "after-head" | "after-get"
  } = {}
) {
  const objects = new Map<string, Uint8Array>()
  const requests: Array<{ method: string; key: string; source: string | null }> = []
  let uploadKey = ""
  const altered = new Uint8Array(bytes.length).fill(42)
  const error = (code: string, status: number) =>
    new Response(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, {
      status,
      headers: { "content-type": "application/xml" },
    })
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const key = decodeURIComponent(new URL(request.url).pathname).replace(/^\/bucket\//, "")
      const sourceHeader = request.headers.get("x-amz-copy-source")
      const source = sourceHeader
        ? decodeURIComponent(sourceHeader).replace(/^\/bucket\//, "")
        : null
      requests.push({ method: request.method, key, source })
      if (request.method === "PUT") {
        if (source !== null) {
          if (key.includes("/blobs/") && options.failure === "promote")
            return error("AccessDenied", 403)
          if (key.includes("/verify_") && options.overwrite === "before-snapshot")
            objects.set(uploadKey, altered)
          const body = objects.get(source)
          if (!body) return error("NoSuchKey", 404)
          objects.set(key, body.slice())
          return new Response('<CopyObjectResult><ETag>"opaque-etag"</ETag></CopyObjectResult>', {
            headers: { "content-type": "application/xml" },
          })
        }
        uploadKey = key
        objects.set(key, new Uint8Array(await request.arrayBuffer()))
        return new Response(null)
      }
      if (request.method === "DELETE") {
        if (options.failure === "cleanup") return error("AccessDenied", 403)
        objects.delete(key)
        return new Response(null, { status: 204 })
      }
      const body = objects.get(key)
      if (!body) return error("NoSuchKey", 404)
      if (request.method === "HEAD") {
        if (options.failure === "head") return error("AccessDenied", 403)
        const headers = new Headers({
          "content-length": String(body.length),
          etag: '"opaque-etag"',
        })
        if (options.checksum) {
          headers.set(
            "x-amz-checksum-sha256",
            createHash("sha256")
              .update(options.checksum === "valid" ? body : altered)
              .digest("base64")
          )
        }
        if (options.overwrite === "after-head") objects.set(uploadKey, altered)
        return new Response(null, { headers })
      }
      if (request.method === "GET") {
        if (options.failure === "read") return error("ServiceUnavailable", 503)
        if (options.overwrite === "after-get") objects.set(uploadKey, altered)
        const responseBytes = options.getBody ?? body
        // Multiple chunks ensure fallback hashes the whole stream, including the final chunk.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let offset = 0; offset < responseBytes.length; offset += 7) {
                controller.enqueue(responseBytes.slice(offset, offset + 7))
              }
              controller.close()
            },
          })
        )
      }
      return error("NotImplemented", 501)
    },
  })
  const storage = new S3BlobStorage({
    endpoint: server.url.origin,
    bucket: "bucket",
    region: "us-east-1",
    pathStyle: true,
    accessKeyId: "fixture-key",
    secretAccessKey: "fixture-secret",
    putRetries: 0,
  })
  async function stage(body: Uint8Array = bytes) {
    const upload = await storage.createUpload({
      uploadId: "upload_fixture",
      expectedDigest: digest,
      sizeBytes: bytes.length,
      mediaType: "application/pdf",
      expiresAt: new Date(Date.now() + 60_000),
    })
    if (upload.strategy !== "direct-put") throw new Error("Expected direct PUT")
    const response = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: body.slice(),
    })
    expect(response.ok).toBe(true)
    return {
      uploadId: upload.uploadId,
      stagingKey: upload.stagingKey,
      expectedDigest: digest,
      expectedSizeBytes: bytes.length,
      fileName: "reference.pdf",
      mediaType: "application/pdf",
      logicalPath: "attachments/reference.pdf",
    }
  }
  return {
    storage,
    stage,
    objects,
    requests,
    recover: () => {
      options.failure = undefined
    },
    close: () => server.stop(true),
  }
}

describe("S3 direct upload verification", () => {
  test.each([
    undefined,
    "valid",
  ] as const)("completes and reads identical PDF bytes with checksum %s", async (checksum) => {
    const f = fixture({ checksum })
    try {
      const input = await f.stage()
      const ref = await f.storage.completeUpload(input)
      expect(ref).toEqual({
        blobId: `blob_${digest.slice("sha256:".length)}`,
        digest,
        sizeBytes: bytes.length,
        fileName: input.fileName,
        mediaType: input.mediaType,
        logicalPath: input.logicalPath,
      })
      expect(f.requests.filter((r) => r.method === "GET").length).toBe(checksum ? 0 : 1)
      expect(await new Response(await f.storage.open(ref.blobId)).bytes()).toEqual(bytes)
      expect([...f.objects.keys()]).toEqual([finalKey])
    } finally {
      f.close()
    }
  })

  test.each([
    "after-head",
    "after-get",
  ] as const)("promotes verified snapshot despite upload overwrite %s", async (overwrite) => {
    const f = fixture({ overwrite })
    try {
      await f.storage.completeUpload(await f.stage())
      expect(f.objects.get(finalKey)).toEqual(bytes)
      const promotion = f.requests.find((r) => r.key === finalKey && r.method === "PUT")
      expect(promotion?.source).toContain("/uploads/verify_")
    } finally {
      f.close()
    }
  })

  test("also isolates the backend-checksum path from a later browser overwrite", async () => {
    const f = fixture({ checksum: "valid", overwrite: "after-head" })
    try {
      await f.storage.completeUpload(await f.stage())
      expect(f.objects.get(finalKey)).toEqual(bytes)
      expect(f.requests.some((r) => r.method === "GET")).toBe(false)
    } finally {
      f.close()
    }
  })

  test.each([
    { name: "same-size altered bytes", body: new Uint8Array(bytes.length), options: {} },
    {
      name: "overwrite before snapshot",
      body: bytes,
      options: { overwrite: "before-snapshot" as const },
    },
    { name: "reported checksum mismatch", body: bytes, options: { checksum: "wrong" as const } },
  ])("rejects $name without creating a final blob", async ({ body, options }) => {
    const f = fixture(options)
    try {
      const input = await f.stage(body)
      await expect(f.storage.completeUpload(input)).rejects.toThrow("checksum mismatch")
      expect([...f.objects.keys()]).toEqual([input.stagingKey])
      expect(f.requests.some((r) => r.key === finalKey)).toBe(false)
      if (options.checksum) expect(f.requests.some((r) => r.method === "GET")).toBe(false)
    } finally {
      f.close()
    }
  })

  test.each([
    { name: "wrong HEAD size", body: bytes.slice(1), options: {} },
    { name: "truncated GET", body: bytes, options: { getBody: bytes.slice(1) } },
    { name: "oversized GET", body: bytes, options: { getBody: new Uint8Array(bytes.length + 1) } },
  ])("rejects $name and cleans the snapshot", async ({ body, options }) => {
    const f = fixture(options)
    try {
      const input = await f.stage(body)
      await expect(f.storage.completeUpload(input)).rejects.toThrow()
      expect([...f.objects.keys()]).toEqual([input.stagingKey])
      expect(f.requests.some((r) => r.key === finalKey)).toBe(false)
    } finally {
      f.close()
    }
  })

  test.each([
    "head",
    "read",
    "promote",
  ] as const)("preserves a %s failure and allows a retry", async (failure) => {
    const f = fixture({ failure })
    try {
      const input = await f.stage()
      await expect(f.storage.completeUpload(input)).rejects.toThrow()
      expect([...f.objects.keys()]).toEqual([input.stagingKey])
      f.recover()
      const ref = await f.storage.completeUpload(input)
      expect(ref.digest).toBe(digest)
      expect([...f.objects.keys()]).toEqual([finalKey])
    } finally {
      f.close()
    }
  })

  test("cleanup failure does not misreport a successfully saved upload", async () => {
    const f = fixture({ failure: "cleanup" })
    try {
      const ref = await f.storage.completeUpload(await f.stage())
      expect(ref.digest).toBe(digest)
      expect(f.objects.get(finalKey)).toEqual(bytes)
    } finally {
      f.close()
    }
  })

  test("missing upload never creates a final blob", async () => {
    const f = fixture()
    try {
      const input = await f.stage()
      f.objects.clear()
      await expect(f.storage.completeUpload(input)).rejects.toThrow("was not found")
      expect(f.objects.size).toBe(0)
    } finally {
      f.close()
    }
  })
})
