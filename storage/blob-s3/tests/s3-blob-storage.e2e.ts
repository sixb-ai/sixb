import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { BlobStorageError } from "@pario/core"
import { S3BlobStorage } from "../src"

const encoder = new TextEncoder()

function createStorage(): S3BlobStorage {
  return new S3BlobStorage({
    bucket: process.env.PARIO_S3_BUCKET,
    endpoint: process.env.PARIO_S3_ENDPOINT,
    accessKeyId: process.env.PARIO_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.PARIO_S3_SECRET_ACCESS_KEY,
    region: "us-east-1",
    basePath: `test-${randomUUID()}`,
  })
}

describe("S3BlobStorage", () => {
  test("stores and opens blobs through S3", async () => {
    const storage = createStorage()

    const fileRef = await storage.put({
      body: encoder.encode("hello s3"),
      fileName: "hello.txt",
      mediaType: "text/plain",
      logicalPath: "docs/hello.txt",
    })

    expect(fileRef.blobId).toBe(`blob_${fileRef.digest.slice("sha256:".length)}`)
    expect(fileRef.sizeBytes).toBe(8)
    expect(fileRef.fileName).toBe("hello.txt")
    expect(fileRef.mediaType).toBe("text/plain")
    expect(fileRef.logicalPath).toBe("docs/hello.txt")

    const stream = await storage.open(fileRef.blobId)
    expect(await new Response(stream).text()).toBe("hello s3")
  })

  test("returns stable content-addressed ids", async () => {
    const storage = createStorage()

    const first = await storage.put({ body: encoder.encode("same") })
    const second = await storage.put({ body: new Blob(["same"]) })
    const third = await storage.put({ body: encoder.encode("different") })

    expect(second.blobId).toBe(first.blobId)
    expect(second.digest).toBe(first.digest)
    expect(third.blobId).not.toBe(first.blobId)
  })

  test("stats existing blobs and treats missing blobs as null", async () => {
    const storage = createStorage()
    const fileRef = await storage.put({ body: encoder.encode("blob info") })
    const missingBlobId = "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    await expect(storage.stat(fileRef.blobId)).resolves.toEqual({
      blobId: fileRef.blobId,
      digest: fileRef.digest,
      sizeBytes: fileRef.sizeBytes,
    })
    await expect(storage.stat(missingBlobId)).resolves.toBeNull()
    await expect(storage.open(missingBlobId)).rejects.toBeInstanceOf(BlobStorageError)
    await expect(storage.open(missingBlobId)).rejects.toThrow(`Unknown blob '${missingBlobId}'`)
  })
})
