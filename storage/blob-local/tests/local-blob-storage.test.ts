import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BlobStorageError } from "@sixb/core"
import { LocalBlobStorage } from "../src"

const encoder = new TextEncoder()

describe("LocalBlobStorage", () => {
  let basePath: string
  let store: LocalBlobStorage

  beforeEach(async () => {
    basePath = await mkdtemp(join(tmpdir(), "sixb-blob-local-"))
    store = new LocalBlobStorage({ basePath })
  })

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true })
  })

  test("stores blobs using the default sha256 content-addressed layout", async () => {
    const fileRef = await store.put({
      body: encoder.encode("hello blob"),
      fileName: "hello.txt",
      mediaType: "text/plain",
      logicalPath: "docs/hello.txt",
    })
    const hex = fileRef.digest.slice("sha256:".length)

    expect(fileRef.blobId).toBe(`blob_${hex}`)
    expect(fileRef.fileName).toBe("hello.txt")
    expect(fileRef.mediaType).toBe("text/plain")
    expect(fileRef.logicalPath).toBe("docs/hello.txt")

    const contentPath = join(basePath, "blobs", "sha256", hex)
    expect(await readFile(contentPath, "utf8")).toBe("hello blob")
  })

  test("returns the same id for identical bytes and different ids for different bytes", async () => {
    const first = await store.put({ body: encoder.encode("same") })
    const second = await store.put({ body: new Blob(["same"]) })
    const third = await store.put({ body: encoder.encode("different") })

    expect(second.blobId).toBe(first.blobId)
    expect(second.digest).toBe(first.digest)
    expect(third.blobId).not.toBe(first.blobId)
  })

  test("open streams the stored bytes", async () => {
    const fileRef = await store.put({ body: encoder.encode("stored body") })

    const stream = await store.open(fileRef.blobId)

    expect(await new Response(stream).text()).toBe("stored body")
  })

  test("stat returns blob info without reading payload through the API", async () => {
    const fileRef = await store.put({ body: encoder.encode("blob info") })
    const hex = fileRef.digest.slice("sha256:".length)
    const contentStat = await stat(join(basePath, "blobs", "sha256", hex))

    await expect(store.stat(fileRef.blobId)).resolves.toEqual({
      blobId: fileRef.blobId,
      digest: fileRef.digest,
      sizeBytes: contentStat.size,
    })
  })

  test("unknown blob ids return null from stat and throw from open", async () => {
    const missingBlobId = "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    await expect(store.stat(missingBlobId)).resolves.toBeNull()
    await expect(store.open(missingBlobId)).rejects.toBeInstanceOf(BlobStorageError)
    await expect(store.open(missingBlobId)).rejects.toThrow(`Unknown blob '${missingBlobId}'`)
  })
})
