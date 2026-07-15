import { describe, expect, test } from "bun:test"
import type { FileRef } from "../src"
import { fileNameFor, InMemoryBlobStorage, isFileRef } from "../src"
import { BlobStorageError } from "../src/blob-storage"

const encoder = new TextEncoder()

const hex = "a".repeat(64)
const validFileRef: FileRef = {
  blobId: `blob_${hex}`,
  digest: `sha256:${hex}`,
  sizeBytes: 3,
}

describe("InMemoryBlobStorage", () => {
  test("returns the same content-addressed id and digest for identical bytes", async () => {
    const store = new InMemoryBlobStorage()

    const first = await store.put({
      body: encoder.encode("same bytes"),
      fileName: "first.txt",
    })
    const second = await store.put({
      body: new Blob(["same bytes"]),
      fileName: "second.txt",
    })

    expect(second.blobId).toBe(first.blobId)
    expect(second.digest).toBe(first.digest)
    expect(first.blobId).toBe(`blob_${first.digest.slice("sha256:".length)}`)
    expect(first.fileName).toBe("first.txt")
    expect(second.fileName).toBe("second.txt")
  })

  test("returns different ids for different bytes", async () => {
    const store = new InMemoryBlobStorage()

    const first = await store.put({ body: encoder.encode("alpha") })
    const second = await store.put({ body: encoder.encode("beta") })

    expect(second.blobId).not.toBe(first.blobId)
    expect(second.digest).not.toBe(first.digest)
  })

  test("open streams the original bytes", async () => {
    const store = new InMemoryBlobStorage()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("streamed "))
        controller.enqueue(encoder.encode("body"))
        controller.close()
      },
    })

    const fileRef = await store.put({ body })
    const stream = await store.open(fileRef.blobId)

    expect(await new Response(stream).text()).toBe("streamed body")
  })

  test("openRange streams a byte range", async () => {
    const store = new InMemoryBlobStorage()
    const fileRef = await store.put({ body: encoder.encode("range bytes") })

    const stream = await store.openRange(fileRef.blobId, {
      start: 6,
      endInclusive: 10,
    })

    expect(await new Response(stream).text()).toBe("bytes")
  })

  test("stat returns size and digest info", async () => {
    const store = new InMemoryBlobStorage()
    const fileRef = await store.put({ body: encoder.encode("blob info") })

    await expect(store.stat(fileRef.blobId)).resolves.toEqual({
      blobId: fileRef.blobId,
      digest: fileRef.digest,
      sizeBytes: fileRef.sizeBytes,
    })
  })

  test("unknown blob ids return null from stat and throw from open", async () => {
    const store = new InMemoryBlobStorage()

    await expect(store.stat("blob_missing")).resolves.toBeNull()
    await expect(store.open("blob_missing")).rejects.toBeInstanceOf(BlobStorageError)
    await expect(store.open("blob_missing")).rejects.toThrow("Unknown blob 'blob_missing'")
  })
})

describe("isFileRef", () => {
  test("accepts a content-addressed reference and produced FileRefs", async () => {
    expect(isFileRef(validFileRef)).toBe(true)

    const produced = await new InMemoryBlobStorage().put({ body: encoder.encode("abc") })
    expect(isFileRef(produced)).toBe(true)
  })

  test("rejects a reference whose blobId does not derive from its digest", () => {
    expect(isFileRef({ ...validFileRef, blobId: `blob_${"b".repeat(64)}` })).toBe(false)
  })

  test("rejects malformed digests, sizes, and metadata", () => {
    expect(isFileRef({ ...validFileRef, digest: "md5:abc" })).toBe(false)
    expect(isFileRef({ ...validFileRef, sizeBytes: -1 })).toBe(false)
    expect(isFileRef({ ...validFileRef, sizeBytes: 1.5 })).toBe(false)
    expect(isFileRef({ ...validFileRef, fileName: 123 })).toBe(false)
    expect(isFileRef(null)).toBe(false)
  })
})

describe("fileNameFor", () => {
  test("prefers the fileName tail, then the logicalPath tail, then a synthetic name", () => {
    expect(fileNameFor({ ...validFileRef, fileName: "dir/report.pdf" })).toBe("report.pdf")
    expect(fileNameFor({ ...validFileRef, logicalPath: "a/b/c.txt" })).toBe("c.txt")
    expect(fileNameFor(validFileRef)).toBe(`blob_${hex}.bin`)
  })
})
