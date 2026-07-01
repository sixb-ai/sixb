import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { BlobStorageError, computeBlobDigest } from "@sixb/core"
import { S3BlobStorage } from "../src"

const encoder = new TextEncoder()

function createStorage(): S3BlobStorage {
  return new S3BlobStorage({
    bucket: process.env.SIXB_S3_BUCKET,
    endpoint: process.env.SIXB_S3_ENDPOINT,
    accessKeyId: process.env.SIXB_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.SIXB_S3_SECRET_ACCESS_KEY,
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

    const rangeStream = await storage.openRange(fileRef.blobId, {
      start: 6,
      endInclusive: 7,
    })
    expect(await new Response(rangeStream).text()).toBe("s3")
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

  test("completes a direct-put staged upload into a FileRef", async () => {
    const storage = createStorage()
    const uploadId = `upload_${randomUUID().replaceAll("-", "")}`
    const body = "staged s3"
    const digest = computeBlobDigest(encoder.encode(body))
    const upload = await storage.createUpload({
      uploadId,
      fileName: "staged.txt",
      mediaType: "text/plain",
      logicalPath: "docs/staged.txt",
      sizeBytes: 9,
      expectedDigest: digest,
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(upload.strategy).toBe("direct-put")
    if (upload.strategy !== "direct-put") {
      throw new Error("Expected direct-put upload strategy.")
    }
    expect(upload.stagingKey).toContain(`/uploads/${uploadId}/object`)

    const uploadResponse = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body,
    })
    expect(uploadResponse.ok).toBe(true)

    const fileRef = await storage.completeUpload({
      uploadId,
      stagingKey: upload.stagingKey,
      fileName: "staged.txt",
      mediaType: "text/plain",
      logicalPath: "docs/staged.txt",
      expectedSizeBytes: 9,
      expectedDigest: digest,
    })

    expect(fileRef.blobId).toBe(`blob_${fileRef.digest.slice("sha256:".length)}`)
    expect(fileRef.sizeBytes).toBe(9)
    expect(fileRef.fileName).toBe("staged.txt")
    expect(fileRef.mediaType).toBe("text/plain")
    expect(fileRef.logicalPath).toBe("docs/staged.txt")

    const stream = await storage.open(fileRef.blobId)
    expect(await new Response(stream).text()).toBe("staged s3")
  })
})
