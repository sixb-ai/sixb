import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import { BlobServiceClient, BlockBlobClient } from "@azure/storage-blob"
import { createSixbClient, uploadFile } from "@sixb/client"
import {
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import {
  blobIdFromDigest,
  computeBlobDigest,
  type DirectPutBlobUploadSession,
} from "@sixb/core/blob-storage/server"
import { SixbServer } from "@sixb/server"
import { AzureBlobStorage, type AzureBlobStorageOptions } from "../src"

const encoder = new TextEncoder()
const prefixes = new Set<string>()
function container() {
  return BlobServiceClient.fromConnectionString(
    process.env.SIXB_AZURE_CONNECTION_STRING!
  ).getContainerClient(process.env.SIXB_AZURE_CONTAINER!)
}
function config(overrides: Partial<AzureBlobStorageOptions> = {}): AzureBlobStorageOptions {
  const basePath = `direct-${randomUUID()}`
  prefixes.add(basePath)
  return {
    connectionString: process.env.SIXB_AZURE_CONNECTION_STRING!,
    container: process.env.SIXB_AZURE_CONTAINER!,
    basePath,
    blockSizeBytes: 64 * 1024,
    retries: 0,
    ...overrides,
  }
}
async function session(storage: AzureBlobStorage, bytes: Uint8Array) {
  const expectedDigest = computeBlobDigest(bytes)
  const upload = await storage.createUpload({
    uploadId: `upload_${randomUUID()}`,
    expectedDigest,
    sizeBytes: bytes.length,
    expiresAt: new Date(Date.now() + 60_000),
  })
  if (upload.strategy !== "direct-put") throw new Error("Expected direct PUT")
  return {
    upload,
    completion: {
      uploadId: upload.uploadId,
      stagingKey: upload.stagingKey,
      expectedDigest,
      expectedSizeBytes: bytes.length,
    },
  }
}
async function put(
  upload: DirectPutBlobUploadSession,
  bytes: Uint8Array,
  headers?: Record<string, string>
) {
  const response = await fetch(upload.url, {
    method: upload.method,
    headers: { ...upload.headers, ...headers },
    body: new Uint8Array(bytes),
  })
  expect(response.status).toBe(201)
}
afterEach(async () => {
  for (const prefix of prefixes) {
    for await (const item of container().listBlobsFlat({ prefix, includeUncommitedBlobs: true })) {
      const blob = container().getBlockBlobClient(item.name)
      await blob.upload(new Uint8Array(), 0)
      await blob.delete()
    }
  }
  prefixes.clear()
})

describe("Azure SAS uploads", () => {
  test("recovers a saved completion receipt when Azure's response is lost", async () => {
    // Regression check: remove complete's catch-path receipt recovery. The first
    // completion then rejects even though Azure durably recorded its success.
    const options = config()
    const storage = new AzureBlobStorage(options)
    const bytes = encoder.encode("receipt response lost")
    const { upload, completion } = await session(storage, bytes)
    await put(upload, bytes)
    const write = BlockBlobClient.prototype.upload
    const mock = spyOn(BlockBlobClient.prototype, "upload").mockImplementation(async function (
      this: BlockBlobClient,
      ...args
    ) {
      const response = await write.apply(this, args)
      if (this.name.endsWith("/session.json")) throw new Error("receipt response lost")
      return response
    })
    try {
      const ref = await storage.completeUpload(completion)
      expect(ref.digest).toBe(completion.expectedDigest)
      expect(await new Response(await storage.open(ref.blobId)).bytes()).toEqual(bytes)
      expect(await new AzureBlobStorage(options).completeUpload(completion)).toEqual(ref)
      await expect(storage.abortUpload(upload)).rejects.toThrow("cannot be aborted")
    } finally {
      mock.mockRestore()
    }
  })

  test.each([
    false,
    true,
  ])("multipart validates receipts and completes concurrently (retry: %s)", async (retry) => {
    const options = config({ multipartThresholdBytes: 1 })
    const storage = new AzureBlobStorage(options)
    const bytes = new Uint8Array(128 * 1024 + 7).map((_, index) => index % 251)
    const upload = await storage.createUpload({
      uploadId: randomUUID(),
      expectedDigest: computeBlobDigest(bytes),
      sizeBytes: bytes.length,
      expiresAt: new Date(Date.now() + 60_000),
    })
    if (upload.strategy !== "multipart") throw new Error("Expected multipart")
    expect(upload.partReceipt).toBe("none")
    const parts: Array<{ partNumber: number }> = []
    for (let offset = 0; offset < bytes.length; offset += upload.partSizeBytes) {
      const partNumber = parts.length + 1
      const signed = await storage.signUploadPart({ ...upload, partNumber })
      expect(signed).not.toHaveProperty("blockId")
      const response = await fetch(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: bytes.slice(offset, offset + upload.partSizeBytes),
      })
      expect(response.status).toBe(201)
      expect(response.headers.get("etag")).toBeNull()
      parts.push({ partNumber })
    }
    const completion = {
      ...upload,
      expectedDigest: computeBlobDigest(bytes),
      expectedSizeBytes: bytes.length,
      parts,
    }
    // Regression: removing validateParts must let at least one invalid list through.
    for (const invalid of [
      parts.slice(1),
      [...parts].reverse(),
      [parts[0]!, parts[0]!, parts[2]!],
      parts.map((p) => ({ ...p, etag: "unexpected" })),
    ]) {
      await expect(storage.completeUpload({ ...completion, parts: invalid })).rejects.toThrow(
        "receipts"
      )
    }
    await expect(storage.signUploadPart({ ...upload, partNumber: 4 })).rejects.toThrow(
      "part number"
    )
    if (retry) {
      const commit = BlockBlobClient.prototype.commitBlockList
      const failPublication = spyOn(
        BlockBlobClient.prototype,
        "commitBlockList"
      ).mockImplementation(function (this: BlockBlobClient, ...args) {
        if (this.name.includes("/blobs/sha256/"))
          return Promise.reject(new Error("publication unavailable"))
        return commit.apply(this, args)
      })
      try {
        await expect(storage.completeUpload(completion)).rejects.toThrow("publication unavailable")
      } finally {
        failPublication.mockRestore()
      }
    }
    const refs = await Promise.all([
      storage.completeUpload(completion),
      new AzureBlobStorage(options).completeUpload(completion),
    ])
    expect(refs[0]).toEqual(refs[1])
    expect(await new Response(await storage.open(refs[0]!.blobId)).bytes()).toEqual(bytes)
    expect(await new AzureBlobStorage(options).completeUpload(completion)).toEqual(refs[0])
    await expect(storage.signUploadPart({ ...upload, partNumber: 1 })).rejects.toThrow(
      "active multipart"
    )
  })

  test("multipart signs sessions above the single-PUT limit and enforces 50,000 blocks", async () => {
    const blockSizeBytes = 8 * 1024 * 1024
    const storage = new AzureBlobStorage(
      config({ blockSizeBytes, directUploadMaxSizeBytes: blockSizeBytes * 50_000 })
    )
    const input = {
      uploadId: randomUUID(),
      expectedDigest: computeBlobDigest(new Uint8Array()),
      sizeBytes: 5_001 * 1024 * 1024,
      expiresAt: new Date(Date.now() + 60_000),
    }
    const upload = await storage.createUpload(input)
    expect(upload.strategy).toBe("multipart")
    if (upload.strategy !== "multipart") throw new Error("Expected multipart")
    expect(
      (
        await storage.signUploadPart({
          ...upload,
          partNumber: Math.ceil(input.sizeBytes / blockSizeBytes),
        })
      ).url
    ).toBeTruthy()
    await storage.abortUpload(upload)
    await expect(
      storage.createUpload({
        ...input,
        uploadId: randomUUID(),
        sizeBytes: blockSizeBytes * 50_000 + 1,
      })
    ).rejects.toThrow("limit")
  })

  test("multipart refuses missing, incorrectly sized, and corrupted blocks", async () => {
    for (const failure of ["missing", "size", "digest"] as const) {
      const storage = new AzureBlobStorage(config({ multipartThresholdBytes: 1 }))
      const bytes = encoder.encode("original bytes")
      const upload = await storage.createUpload({
        uploadId: randomUUID(),
        expectedDigest: computeBlobDigest(bytes),
        sizeBytes: bytes.length,
        expiresAt: new Date(Date.now() + 60_000),
      })
      if (upload.strategy !== "multipart") throw new Error("Expected multipart")
      const signed = await storage.signUploadPart({ ...upload, partNumber: 1 })
      if (failure !== "missing") {
        const body = failure === "size" ? bytes.slice(1) : new Uint8Array(bytes.length)
        expect(
          (await fetch(signed.url, { method: "PUT", headers: signed.headers, body })).status
        ).toBe(201)
      }
      const completion = {
        ...upload,
        expectedDigest: computeBlobDigest(bytes),
        expectedSizeBytes: bytes.length,
        parts: [{ partNumber: 1 }],
      }
      await expect(storage.completeUpload(completion)).rejects.toThrow()
      expect(await storage.stat(blobIdFromDigest(completion.expectedDigest))).toBeNull()
      await storage.abortUpload(upload)
      await storage.abortUpload(upload)
      await expect(storage.signUploadPart({ ...upload, partNumber: 1 })).rejects.toThrow(
        "active multipart"
      )
      await expect(storage.completeUpload(completion)).rejects.toThrow("aborted")
    }
  })
  test("retries publication when recording completion fails, then survives cleanup failure", async () => {
    const options = config()
    const storage = new AzureBlobStorage(options)
    const bytes = encoder.encode("durable receipt")
    const { upload, completion } = await session(storage, bytes)
    await put(upload, bytes)
    const write = BlockBlobClient.prototype.upload
    const failReceipt = spyOn(BlockBlobClient.prototype, "upload").mockImplementation(function (
      this: BlockBlobClient,
      ...args
    ) {
      if (this.name.endsWith("/session.json"))
        return Promise.reject(new Error("receipt write failed"))
      return write.apply(this, args)
    })
    try {
      await expect(storage.completeUpload(completion)).rejects.toThrow("receipt write failed")
    } finally {
      failReceipt.mockRestore()
    }
    expect(await container().getBlockBlobClient(upload.stagingKey).exists()).toBe(true)
    const remove = BlockBlobClient.prototype.deleteIfExists
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    const failCleanup = spyOn(BlockBlobClient.prototype, "deleteIfExists").mockImplementation(
      function (this: BlockBlobClient, ...args) {
        if (this.name === upload.stagingKey) return Promise.reject(new Error("cleanup failed"))
        return remove.apply(this, args)
      }
    )
    try {
      const ref = await storage.completeUpload(completion)
      expect(ref.digest).toBe(completion.expectedDigest)
      expect(warning).toHaveBeenCalledTimes(1)
      expect(await new AzureBlobStorage(options).completeUpload(completion)).toEqual(ref)
      expect(await new Response(await storage.open(ref.blobId)).bytes()).toEqual(bytes)
    } finally {
      failCleanup.mockRestore()
      warning.mockRestore()
    }
  })

  test.each([
    1,
    32 * 1024 * 1024,
  ])("the standard client uploads 26 MiB with multipart threshold %i", async (multipartThresholdBytes) => {
    const storage = new AzureBlobStorage(
      config({ blockSizeBytes: 8 * 1024 * 1024, multipartThresholdBytes })
    )
    const host = new SixbHost({
      id: "azure-files-test",
      ontology: [],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: storage,
      queues: new InMemoryQueues(),
    })
    const server = new SixbServer({
      host,
      port: 49011,
      hostname: "127.0.0.1",
      quiet: true,
      browser: {
        publicOrigin: "http://127.0.0.1:49011",
        allowedOrigins: [{ origin: "http://app.localhost", audience: "app" }],
      },
    })
    await server.start()
    const paths: string[] = []
    const tracedFetch: typeof fetch = Object.assign(
      (...args: Parameters<typeof fetch>) => {
        paths.push(new URL(args[0] instanceof Request ? args[0].url : String(args[0])).pathname)
        return fetch(...args)
      },
      { preconnect: fetch.preconnect }
    )
    try {
      const client = createSixbClient({ baseUrl: "http://127.0.0.1:49011", fetch: tracedFetch })
      const bytes = new Uint8Array(26 * 1024 * 1024).fill(19)
      const ref = await uploadFile(
        new File([bytes], "large.bin", { type: "application/octet-stream" }),
        { client, fetch: tracedFetch }
      )
      expect(ref.digest).toBe(computeBlobDigest(bytes))
      expect(ref.sizeBytes).toBe(bytes.length)
      expect(ref.fileName).toBe("large.bin")
      expect(paths).toHaveLength(multipartThresholdBytes === 1 ? 10 : 3)
      expect(paths[0]).toBe("/api/files/uploads")
      expect(paths.at(-1)).toMatch(/^\/api\/files\/uploads\/upload_[a-f0-9]+\/complete$/)
      expect(await new Response(await storage.open(ref.blobId)).bytes()).toEqual(bytes)
    } finally {
      await server.stop()
    }
  }, 30_000)

  test("bounds active completions and releases capacity after success", async () => {
    const storage = new AzureBlobStorage(config({ completionConcurrency: 1 }))
    const bytes = encoder.encode("bounded")
    const first = await session(storage, bytes)
    const second = await session(storage, bytes)
    await put(first.upload, bytes)
    await put(second.upload, bytes)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const download = BlockBlobClient.prototype.download
    const mock = spyOn(BlockBlobClient.prototype, "download").mockImplementation(async function (
      this: BlockBlobClient,
      ...args
    ) {
      if (this.name === first.upload.stagingKey) {
        started.resolve()
        await release.promise
      }
      return download.apply(this, args)
    })
    const pending = storage.completeUpload(first.completion)
    void pending.catch(() => undefined)
    try {
      await started.promise
      await expect(storage.completeUpload(second.completion)).rejects.toThrow("capacity reached")
    } finally {
      release.resolve()
      await pending.catch(() => undefined)
      mock.mockRestore()
    }
    expect(await storage.completeUpload(second.completion)).toEqual(await pending)
  })

  test("a completion deadline cancels a stalled verification stream and frees capacity", async () => {
    const storage = new AzureBlobStorage(
      config({ completionConcurrency: 1, completionTimeoutMillis: 250 })
    )
    const bytes = encoder.encode("timeout")
    const { upload, completion } = await session(storage, bytes)
    await put(upload, bytes)
    const download = BlockBlobClient.prototype.download
    let destroyed = false
    const mock = spyOn(BlockBlobClient.prototype, "download").mockImplementation(async function (
      this: BlockBlobClient,
      ...args
    ) {
      const response = await download.apply(this, args)
      if (this.name !== upload.stagingKey) return response
      const original = response.readableStreamBody
      if (original instanceof Readable) original.destroy()
      return {
        ...response,
        readableStreamBody: new Readable({
          read() {},
          destroy(error, callback) {
            destroyed = true
            callback(error)
          },
        }),
      }
    })
    try {
      await expect(storage.completeUpload(completion)).rejects.toThrow()
    } finally {
      mock.mockRestore()
    }
    expect(destroyed).toBe(true)
    expect(await storage.stat(blobIdFromDigest(completion.expectedDigest))).toBeNull()
    expect((await storage.completeUpload(completion)).digest).toBe(completion.expectedDigest)
  })

  test("an abort wins a race against completion's durable receipt", async () => {
    const storage = new AzureBlobStorage(config())
    const bytes = encoder.encode("abort race")
    const { upload, completion } = await session(storage, bytes)
    await put(upload, bytes)
    const commit = BlockBlobClient.prototype.commitBlockList
    const mock = spyOn(BlockBlobClient.prototype, "commitBlockList").mockImplementation(
      async function (this: BlockBlobClient, ...args) {
        const response = await commit.apply(this, args)
        if (this.name.includes("/blobs/sha256/")) await storage.abortUpload(upload)
        return response
      }
    )
    try {
      await expect(storage.completeUpload(completion)).rejects.toThrow("aborted during completion")
    } finally {
      mock.mockRestore()
    }
    await expect(storage.completeUpload(completion)).rejects.toThrow("aborted")
  })

  test("verifies direct uploads, preserves reference metadata, and retries across instances", async () => {
    const options = config()
    const storage = new AzureBlobStorage(options)
    for (const bytes of [encoder.encode("direct azure bytes"), new Uint8Array()]) {
      const { upload, completion } = await session(storage, bytes)
      await put(upload, bytes)
      const input = {
        ...completion,
        fileName: "report.txt",
        mediaType: "text/plain",
        logicalPath: "reports/report.txt",
      }
      const ref = await storage.completeUpload(input)
      expect(ref).toEqual({
        blobId: blobIdFromDigest(completion.expectedDigest),
        digest: completion.expectedDigest,
        sizeBytes: bytes.length,
        fileName: input.fileName,
        mediaType: input.mediaType,
        logicalPath: input.logicalPath,
      })
      expect(await new Response(await storage.open(ref.blobId)).bytes()).toEqual(bytes)
      expect(await container().getBlockBlobClient(upload.stagingKey).exists()).toBe(false)
      expect(await new AzureBlobStorage(options).completeUpload(input)).toEqual(ref)
      await expect(
        storage.completeUpload({ ...input, expectedDigest: `sha256:${"a".repeat(64)}` })
      ).rejects.toThrow("identity differs")
    }
  })

  test("supports concurrent completions without trusting missing staging", async () => {
    const options = config()
    const storage = new AzureBlobStorage(options)
    const bytes = new Uint8Array(128 * 1024).fill(11)
    const { upload, completion } = await session(storage, bytes)
    await put(upload, bytes)
    const refs = await Promise.all([
      storage.completeUpload(completion),
      new AzureBlobStorage(options).completeUpload(completion),
    ])
    expect(refs[0]).toEqual(refs[1])
    const missing = await session(storage, bytes)
    await expect(storage.completeUpload(missing.completion)).rejects.toThrow()
  })

  test("rejects size and digest mismatches even with forged metadata or existing final content", async () => {
    // Regression check: remove verifyUpload's SHA-256 comparison. The same-size
    // forged upload then completes against the pre-existing final object.
    const storage = new AzureBlobStorage(config())
    const bytes = encoder.encode("verified")
    await storage.put({ body: bytes })
    for (const bad of [encoder.encode("forged!!"), encoder.encode("short")]) {
      const { upload, completion } = await session(storage, bytes)
      await put(upload, bad, { "x-ms-meta-sha256": completion.expectedDigest.slice(7) })
      await expect(storage.completeUpload(completion)).rejects.toThrow(
        bad.length === bytes.length ? "SHA-256" : "size mismatch"
      )
      expect(await container().getBlockBlobClient(upload.stagingKey).exists()).toBe(true)
    }
  })

  test("detects changes between hashing and copying, and during copying", async () => {
    // Regression check: remove publish's checkSource calls. The changed source
    // would be committed under the original digest even though the hash verified.
    for (const phase of ["before", "after"] as const) {
      const storage = new AzureBlobStorage(config())
      const bytes = new Uint8Array(128 * 1024).fill(3)
      const { upload, completion } = await session(storage, bytes)
      await put(upload, bytes)
      const copy = BlockBlobClient.prototype.stageBlockFromURL
      let changed = false
      const mock = spyOn(BlockBlobClient.prototype, "stageBlockFromURL").mockImplementation(
        async function (this: BlockBlobClient, ...args) {
          if (phase === "before" && !changed) {
            changed = true
            await put(upload, new Uint8Array(bytes.length).fill(4))
          }
          const response = await copy.apply(this, args)
          if (phase === "after" && !changed) {
            changed = true
            await put(upload, new Uint8Array(bytes.length).fill(4))
          }
          return response
        }
      )
      try {
        await expect(storage.completeUpload(completion)).rejects.toMatchObject({ statusCode: 412 })
      } finally {
        mock.mockRestore()
      }
      expect(await storage.stat(blobIdFromDigest(completion.expectedDigest))).toBeNull()
    }
  })

  test("pins downloads to the observed ETag", async () => {
    const storage = new AzureBlobStorage(config())
    const bytes = encoder.encode("original")
    const { upload, completion } = await session(storage, bytes)
    await put(upload, bytes)
    const download = BlockBlobClient.prototype.download
    let changed = false
    const mock = spyOn(BlockBlobClient.prototype, "download").mockImplementation(async function (
      this: BlockBlobClient,
      ...args
    ) {
      if (this.name === upload.stagingKey && !changed) {
        changed = true
        await put(upload, encoder.encode("modified"))
      }
      return download.apply(this, args)
    })
    try {
      await expect(storage.completeUpload(completion)).rejects.toMatchObject({ statusCode: 412 })
    } finally {
      mock.mockRestore()
    }
    expect(await storage.stat(blobIdFromDigest(completion.expectedDigest))).toBeNull()
  })

  test("rejects encoded content instead of hashing a possibly decoded response", async () => {
    const storage = new AzureBlobStorage(config())
    const bytes = encoder.encode("not gzip")
    const { upload, completion } = await session(storage, bytes)
    await put(upload, bytes, { "x-ms-blob-content-encoding": "gzip" })
    await expect(storage.completeUpload(completion)).rejects.toThrow("without content encoding")
  })

  test("enforces limits, expiry, session uniqueness, and staging ownership", async () => {
    const storage = new AzureBlobStorage(config({ directUploadMaxSizeBytes: 10 }))
    const input = {
      uploadId: "valid",
      sizeBytes: 3,
      expectedDigest: computeBlobDigest(encoder.encode("abc")),
      expiresAt: new Date(Date.now() + 60_000),
    }
    for (const override of [
      { sizeBytes: 11 },
      { sizeBytes: -1 },
      { expectedDigest: "sha256:bad" as const },
      { expiresAt: new Date(0) },
      { expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
      { uploadId: "../other" },
    ])
      await expect(storage.createUpload({ ...input, ...override })).rejects.toThrow()
    const upload = await storage.createUpload(input)
    await expect(storage.createUpload(input)).rejects.toThrow()
    for (const stagingKey of [
      upload.stagingKey.replace("/object", "/session.json"),
      "sixb/blobs/sha256/anything",
    ]) {
      await expect(storage.abortUpload({ uploadId: upload.uploadId, stagingKey })).rejects.toThrow(
        "staging key"
      )
    }
    const sessionBlob = container().getBlockBlobClient(
      upload.stagingKey.replace(/object$/, "session.json")
    )
    const record: Record<string, unknown> = JSON.parse(
      (await sessionBlob.downloadToBuffer()).toString()
    )
    record.expiresAt = Date.now() - 1
    const text = JSON.stringify(record)
    await sessionBlob.upload(text, Buffer.byteLength(text))
    await expect(
      storage.completeUpload({
        uploadId: upload.uploadId,
        stagingKey: upload.stagingKey,
        expectedDigest: input.expectedDigest,
        expectedSizeBytes: 3,
      })
    ).rejects.toThrow("expired")
  })

  test("abort is durable and idempotent even if a still-valid SAS recreates staging", async () => {
    const storage = new AzureBlobStorage(config())
    const bytes = encoder.encode("aborted")
    const { upload, completion } = await session(storage, bytes)
    await put(upload, bytes)
    await storage.abortUpload(upload)
    await storage.abortUpload(upload)
    expect(await container().getBlockBlobClient(upload.stagingKey).exists()).toBe(false)
    await put(upload, bytes)
    await expect(storage.completeUpload(completion)).rejects.toThrow("aborted")
    expect(await storage.stat(blobIdFromDigest(completion.expectedDigest))).toBeNull()
  })

  test("SAS is scoped to staging and CORS permits the documented browser request", async () => {
    const storage = new AzureBlobStorage(config())
    const bytes = encoder.encode("cors")
    const { upload } = await session(storage, bytes)
    const response = await fetch(upload.url, {
      method: "OPTIONS",
      headers: {
        origin: "http://app.localhost",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type,x-ms-blob-type",
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://app.localhost")
    const modified = new URL(upload.url)
    modified.pathname = modified.pathname.replace(/object$/, "session.json")
    expect(
      (await fetch(modified, { method: "PUT", headers: upload.headers, body: bytes })).status
    ).toBe(403)
    expect((await fetch(upload.url, { method: "GET" })).status).toBe(403)
  })
})
