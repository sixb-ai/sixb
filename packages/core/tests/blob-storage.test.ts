import { describe, expect, test } from "bun:test"
import { BlobStorageError, InMemoryBlobStorage } from "../src"

const encoder = new TextEncoder()

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
