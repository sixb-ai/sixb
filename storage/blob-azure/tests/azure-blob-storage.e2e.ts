import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { BlobServiceClient, BlockBlobClient } from "@azure/storage-blob"
import {
  BlobStorageError,
  blobIdFromDigest,
  computeBlobDigest,
  supportsDirectUpload,
} from "@sixb/core/blob-storage/server"
import { runBlobStorageContractSuite } from "@sixb/core/testing"
import { AzureBlobStorage, type AzureBlobStorageOptions } from "../src"

const encoder = new TextEncoder()
const prefixes = new Set<string>()

function container() {
  return BlobServiceClient.fromConnectionString(
    process.env.SIXB_AZURE_CONNECTION_STRING!
  ).getContainerClient(process.env.SIXB_AZURE_CONTAINER!)
}

function options(): AzureBlobStorageOptions {
  const basePath = `test-${randomUUID()}`
  prefixes.add(basePath)
  return {
    connectionString: process.env.SIXB_AZURE_CONNECTION_STRING!,
    container: process.env.SIXB_AZURE_CONTAINER!,
    basePath,
    blockSizeBytes: 64 * 1024,
    retries: 0,
  }
}

afterEach(async () => {
  for (const prefix of prefixes) {
    for await (const blob of container().listBlobsFlat({ prefix, includeUncommitedBlobs: true })) {
      const client = container().getBlockBlobClient(blob.name)
      await client.upload(new Uint8Array(), 0)
      await client.delete()
    }
  }
  prefixes.clear()
})

runBlobStorageContractSuite("AzureBlobStorage contract", {
  createStorage: () => new AzureBlobStorage(options()),
})

describe("AzureBlobStorage", () => {
  test("all body types, empty bytes, metadata, and persistence across instances", async () => {
    const config = options()
    const storage = new AzureBlobStorage(config)
    const bytes = encoder.encode("hello azure")
    const digest = computeBlobDigest(bytes)
    const bodyTypes = [
      bytes,
      bytes.buffer,
      new Blob([bytes]),
      new Blob([bytes]).stream(),
      encoder.encode("!hello azure!").subarray(1, -1),
    ]
    for (const [index, body] of bodyTypes.entries()) {
      const ref = await storage.put({
        body,
        fileName: `${index}.txt`,
        mediaType: "text/plain",
        logicalPath: `reports/${index}.txt`,
        expectedSizeBytes: bytes.length,
      })
      expect(ref).toEqual({
        blobId: blobIdFromDigest(digest),
        digest,
        sizeBytes: bytes.length,
        fileName: `${index}.txt`,
        mediaType: "text/plain",
        logicalPath: `reports/${index}.txt`,
      })
      expect(await new Response(await new AzureBlobStorage(config).open(ref.blobId)).text()).toBe(
        "hello azure"
      )
    }
    const empty = await storage.put({ body: new Uint8Array(), expectedSizeBytes: 0 })
    expect(empty.digest).toBe(computeBlobDigest(new Uint8Array()))
    expect(await new Response(await storage.open(empty.blobId)).bytes()).toEqual(new Uint8Array())
    expect(supportsDirectUpload(storage)).toBe(true)
    expect(await names(`${config.basePath}/uploads/`)).toEqual([])
  })

  test("streams multiple blocks, reads inclusive ranges, and cancels downloads", async () => {
    const storage = new AzureBlobStorage(options())
    const bytes = new Uint8Array(256 * 1024 + 7)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const ref = await storage.put({ body: new Blob([bytes]).stream() })
    expect(ref.digest).toBe(computeBlobDigest(bytes))
    expect(await storage.stat(ref.blobId)).toEqual({
      blobId: ref.blobId,
      digest: ref.digest,
      sizeBytes: bytes.length,
    })
    for (const [start, endInclusive] of [
      [0, 0],
      [65530, 65540],
      [bytes.length - 1, bytes.length - 1],
    ]) {
      const actual = await new Response(
        await storage.openRange(ref.blobId, { start: start!, endInclusive: endInclusive! })
      ).bytes()
      expect(actual).toEqual(bytes.slice(start, endInclusive! + 1))
    }
    const stream = await storage.open(ref.blobId)
    await stream.cancel()
    expect(await new Response(await storage.open(ref.blobId)).bytes()).toEqual(bytes)
  })

  test("concurrent identical writers publish one complete immutable object", async () => {
    const config = options()
    const bytes = new Uint8Array(192 * 1024 + 1).fill(37)
    const refs = await Promise.all(
      Array.from({ length: 4 }, () => new AzureBlobStorage(config).put({ body: bytes }))
    )
    expect(new Set(refs.map((ref) => ref.blobId)).size).toBe(1)
    expect(
      await new Response(await new AzureBlobStorage(config).open(refs[0]!.blobId)).bytes()
    ).toEqual(bytes)
    expect(await names(`${config.basePath}/blobs/`)).toHaveLength(1)
    expect(await names(`${config.basePath}/uploads/`)).toEqual([])
  })

  test("size errors and source failures publish nothing and remove staged blocks", async () => {
    const config = options()
    const storage = new AzureBlobStorage(config)
    const bytes = new Uint8Array(128 * 1024).fill(7)
    for (const expectedSizeBytes of [bytes.length - 1, bytes.length + 1]) {
      await expect(storage.put({ body: bytes, expectedSizeBytes })).rejects.toThrow("size mismatch")
    }
    let reads = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ < 3) controller.enqueue(bytes)
        else controller.error(new Error("source broke"))
      },
    })
    await expect(storage.put({ body: stream })).rejects.toThrow("source broke")
    expect(await names(config.basePath!)).toEqual([])
  })

  test("rejects missing/invalid ids but propagates a missing container", async () => {
    const config = options()
    const storage = new AzureBlobStorage(config)
    for (const id of ["../invalid", `blob_${"a".repeat(64)}`]) {
      expect(await storage.stat(id)).toBeNull()
      await expect(storage.open(id)).rejects.toBeInstanceOf(BlobStorageError)
      await expect(storage.openRange(id, { start: 0, endInclusive: 0 })).rejects.toBeInstanceOf(
        BlobStorageError
      )
    }
    const missingContainer = new AzureBlobStorage({ ...config, container: "missing-container" })
    await expect(missingContainer.stat(`blob_${"a".repeat(64)}`)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  test("rejects a conflicting existing final object's size", async () => {
    const config = options()
    const bytes = encoder.encode("content")
    const digest = computeBlobDigest(bytes)
    await container()
      .getBlockBlobClient(`${config.basePath}/blobs/sha256/${digest.slice(7)}`)
      .upload("x", 1)
    await expect(new AzureBlobStorage(config).put({ body: bytes })).rejects.toThrow("size mismatch")
  })

  test("copied blocks stay unreadable when final publication fails", async () => {
    const config = options()
    const storage = new AzureBlobStorage(config)
    const bytes = new Uint8Array(128 * 1024).fill(9)
    const blobId = blobIdFromDigest(computeBlobDigest(bytes))
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const commit = BlockBlobClient.prototype.commitBlockList
    const mock = spyOn(BlockBlobClient.prototype, "commitBlockList").mockImplementation(
      async function (this: BlockBlobClient, blocks, settings) {
        if (this.url.includes("/blobs/sha256/")) {
          ready.resolve()
          await release.promise
          throw new Error("publication failed")
        }
        return commit.call(this, blocks, settings)
      }
    )
    const upload = storage.put({ body: bytes })
    void upload.catch(() => undefined)
    try {
      await ready.promise
      expect(await storage.stat(blobId)).toBeNull()
      await expect(storage.open(blobId)).rejects.toThrow("Unknown blob")
    } finally {
      release.resolve()
      try {
        await expect(upload).rejects.toThrow("publication failed")
      } finally {
        mock.mockRestore()
      }
    }
    expect(await storage.stat(blobId)).toBeNull()
    expect(await names(`${config.basePath}/uploads/`)).toEqual([])
    // A later successful put can publish despite the abandoned uncommitted blocks.
    await storage.put({ body: bytes })
    expect(await new Response(await storage.open(blobId)).bytes()).toEqual(bytes)
  })

  test("cancellation after Azure accepts blocks cleans staging without publishing", async () => {
    const config = options()
    const storage = new AzureBlobStorage(config)
    const firstBlock = Promise.withResolvers<void>()
    const stage = BlockBlobClient.prototype.stageBlock
    const mock = spyOn(BlockBlobClient.prototype, "stageBlock").mockImplementation(async function (
      this: BlockBlobClient,
      ...args
    ) {
      const response = await stage.apply(this, args)
      firstBlock.resolve()
      return response
    })
    const abort = new AbortController()
    let cancelled = false
    const upload = storage.put({
      signal: abort.signal,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(128 * 1024))
        },
        cancel() {
          cancelled = true
        },
      }),
    })
    void upload.catch(() => undefined)
    try {
      await firstBlock.promise
      abort.abort(new Error("cancel accepted upload"))
      await expect(upload).rejects.toThrow("cancel accepted upload")
    } finally {
      abort.abort()
      await upload.catch(() => undefined)
      mock.mockRestore()
    }
    expect(cancelled).toBe(true)
    expect(await names(config.basePath!)).toEqual([])
  })

  test("deduplication never overwrites an existing content object", async () => {
    // Regression check: remove publication's ifNoneMatch condition. With the
    // initial stat forced to miss, the second write changes the final ETag.
    const config = options()
    const storage = new AzureBlobStorage(config)
    const bytes = encoder.encode("same content")
    const ref = await storage.put({ body: bytes })
    const final = container().getBlockBlobClient(
      `${config.basePath}/blobs/sha256/${ref.digest.slice(7)}`
    )
    const before = await final.getProperties()
    const getProperties = BlockBlobClient.prototype.getProperties
    let missed = false
    const mock = spyOn(BlockBlobClient.prototype, "getProperties").mockImplementation(function (
      this: BlockBlobClient,
      ...args
    ) {
      if (!missed && this.url === final.url) {
        missed = true
        return Promise.reject(
          Object.assign(new Error("simulated concurrent creation"), { code: "BlobNotFound" })
        )
      }
      return getProperties.apply(this, args)
    })
    try {
      expect(await storage.put({ body: bytes })).toEqual(ref)
    } finally {
      mock.mockRestore()
    }
    expect((await final.getProperties()).etag).toBe(before.etag)
  })

  test("SDK retries replay block bytes without consuming or hashing the source again", async () => {
    const config = options()
    const attempts: Uint8Array[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const body = request.method === "PUT" ? await request.bytes() : undefined
        if (url.pathname.includes("/uploads/") && url.searchParams.get("comp") === "block") {
          attempts.push(body!)
          if (attempts.length === 1) {
            return new Response(
              "<Error><Code>ServerBusy</Code><Message>Retry this block</Message></Error>",
              {
                status: 503,
                headers: {
                  "content-type": "application/xml",
                  "x-ms-error-code": "ServerBusy",
                  "retry-after": "0",
                },
              }
            )
          }
        }
        url.port = "49010"
        const headers = new Headers(request.headers)
        headers.set("host", url.host)
        return fetch(url, { method: request.method, headers, body })
      },
    })
    // Route only SDK block uploads through the fault injector. Copy-source URLs
    // must retain the real emulator endpoint (Azurite only copies within itself).
    const proxied = BlobServiceClient.fromConnectionString(
      config.connectionString!.replace(":49010/", `:${proxy.port}/`),
      { retryOptions: { maxTries: 2 } }
    ).getContainerClient(config.container)
    const stage = BlockBlobClient.prototype.stageBlock
    const mock = spyOn(BlockBlobClient.prototype, "stageBlock").mockImplementation(function (
      this: BlockBlobClient,
      ...args
    ) {
      return stage.apply(proxied.getBlockBlobClient(this.name), args)
    })
    try {
      const storage = new AzureBlobStorage({
        ...config,
        retries: 1,
      })
      let reads = 0
      const bytes = encoder.encode("retry the same bytes")
      const ref = await storage.put({
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            reads++
            controller.enqueue(bytes)
            controller.close()
          },
        }),
      })
      expect(reads).toBe(1)
      expect(attempts).toEqual([bytes, bytes])
      expect(ref.digest).toBe(computeBlobDigest(bytes))
      expect(await new Response(await storage.open(ref.blobId)).bytes()).toEqual(bytes)
    } finally {
      mock.mockRestore()
      await proxy.stop(true)
    }
  }, 30_000)
})

async function names(prefix: string): Promise<string[]> {
  const result: string[] = []
  for await (const blob of container().listBlobsFlat({ prefix, includeUncommitedBlobs: true }))
    result.push(blob.name)
  return result
}
