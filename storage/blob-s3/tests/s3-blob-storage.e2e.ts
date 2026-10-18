import { describe, expect, spyOn, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { BlobStorageError, computeBlobDigest } from "@sixb/core/blob-storage/server"
import { runBlobStorageContractSuite } from "@sixb/core/testing"
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

function rawS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.SIXB_S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: process.env.SIXB_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.SIXB_S3_SECRET_ACCESS_KEY ?? "",
    },
  })
}

runBlobStorageContractSuite("S3BlobStorage contract", {
  createStorage,
})

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

  test("stores empty blobs without opening a multipart upload", async () => {
    const storage = createStorage()

    const fileRef = await storage.put({
      body: new Uint8Array(),
      expectedSizeBytes: 0,
      fileName: "empty.txt",
    })

    expect(fileRef.sizeBytes).toBe(0)
    expect(await new Response(await storage.open(fileRef.blobId)).bytes()).toEqual(new Uint8Array())
  })

  test("streams multipart bodies through bounded staging", async () => {
    const storage = createStorage()
    const chunk = new Uint8Array(1024 * 1024).fill(7)
    const chunkCount = 12
    const expectedSizeBytes = chunk.byteLength * chunkCount
    const hash = createHash("sha256")
    for (let index = 0; index < chunkCount; index += 1) {
      hash.update(chunk)
    }
    let emittedChunks = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emittedChunks === chunkCount) {
          controller.close()
          return
        }
        emittedChunks += 1
        controller.enqueue(chunk)
      },
    })

    const fileRef = await storage.put({ body, expectedSizeBytes })

    expect(fileRef.sizeBytes).toBe(expectedSizeBytes)
    expect(fileRef.digest).toBe(`sha256:${hash.digest("hex")}`)
    expect(emittedChunks).toBe(chunkCount)
    expect(
      await new Response(
        await storage.openRange(fileRef.blobId, {
          start: expectedSizeBytes - 1,
          endInclusive: expectedSizeBytes - 1,
        })
      ).bytes()
    ).toEqual(new Uint8Array([7]))
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

  test.each([
    { tampering: "body", status: 400, code: "BadDigest" },
    { tampering: "signature", status: 403, code: "SignatureDoesNotMatch" },
  ] as const)("rejects a direct upload with a tampered $tampering", async ({
    tampering,
    status,
    code,
  }) => {
    const storage = createStorage()
    const uploadId = `upload_${randomUUID().replaceAll("-", "")}`
    const body = "staged s3"
    const digest = computeBlobDigest(encoder.encode(body))
    const upload = await storage.createUpload({
      uploadId,
      sizeBytes: body.length,
      expectedDigest: digest,
      expiresAt: new Date(Date.now() + 60_000),
    })
    if (upload.strategy !== "direct-put") {
      throw new Error("Expected direct-put upload strategy.")
    }

    const url = new URL(upload.url)
    if (tampering === "signature") {
      url.searchParams.set("X-Amz-Signature", "0".repeat(64))
    }
    // Negative control: removing the signature/body mutation must make this test fail.
    // Keep the body length unchanged to test checksum verification, not Content-Length.
    const response = await fetch(url, {
      method: upload.method,
      headers: upload.headers,
      body: tampering === "body" ? "altered!!" : body,
    })
    expect(response.status).toBe(status)
    expect(await response.text()).toContain(`<Code>${code}</Code>`)
    await expect(
      storage.completeUpload({
        uploadId,
        stagingKey: upload.stagingKey,
        expectedSizeBytes: body.length,
        expectedDigest: digest,
      })
    ).rejects.toBeInstanceOf(BlobStorageError)
    await expect(storage.stat(`blob_${digest.slice("sha256:".length)}`)).resolves.toBeNull()
  })

  test.each([
    0,
    16,
    10 * 1024 * 1024,
  ])("verifies %s bytes without backend checksum metadata", async (sizeBytes) => {
    const storage = createStorage()
    const uploadId = `upload_${randomUUID().replaceAll("-", "")}`
    const body = new Uint8Array(sizeBytes).fill(42)
    const digest = computeBlobDigest(body)
    const upload = await storage.createUpload({
      uploadId,
      sizeBytes: body.byteLength,
      expectedDigest: digest,
      expiresAt: new Date(Date.now() + 60_000),
    })
    if (upload.strategy !== "direct-put") {
      throw new Error("Expected direct-put upload strategy.")
    }

    // Stage the bytes with a plain PUT (no x-amz-checksum-sha256), so the backend stores no
    // verified checksum. Completion must hash the snapshot bytes rather than trust the digest.
    await rawS3Client().send(
      new PutObjectCommand({
        Bucket: process.env.SIXB_S3_BUCKET,
        Key: upload.stagingKey,
        Body: body,
        ContentLength: body.byteLength,
      })
    )

    const send = spyOn(S3Client.prototype, "send")
    try {
      // A wrong declared digest must still be rejected, even without backend checksum metadata.
      await expect(
        storage.completeUpload({
          uploadId,
          stagingKey: upload.stagingKey,
          expectedSizeBytes: body.byteLength,
          expectedDigest: `sha256:${"0".repeat(64)}`,
        })
      ).rejects.toThrow("checksum mismatch")

      const ref = await storage.completeUpload({
        uploadId,
        stagingKey: upload.stagingKey,
        expectedSizeBytes: body.byteLength,
        expectedDigest: digest,
      })
      expect(ref.digest).toBe(digest)
      expect(await new Response(await storage.open(ref.blobId)).bytes()).toEqual(body)
      // Prove this real-backend case exercised the streaming fallback, not just a checksum that
      // the backend happened to add during COPY. Both rejected and accepted attempts read snapshots.
      expect(
        send.mock.calls.filter(
          ([command]) =>
            command instanceof GetObjectCommand && command.input.Key?.includes("/uploads/verify_")
        )
      ).toHaveLength(2)
    } finally {
      send.mockRestore()
    }
  })

  // The operator script configures itself from S3_* and reports failure through its exit code;
  // importing it runs the same top-level checks without a cold process. It moves 2 x 10 MiB.
  test("runs the release smoke check against the local S3 service", async () => {
    const env: Record<string, string | undefined> = {
      S3_BUCKET: process.env.SIXB_S3_BUCKET,
      S3_ENDPOINT: process.env.SIXB_S3_ENDPOINT,
      S3_ACCESS_KEY_ID: process.env.SIXB_S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: process.env.SIXB_S3_SECRET_ACCESS_KEY,
      S3_REGION: undefined,
      AWS_REGION: undefined,
      S3_SESSION_TOKEN: undefined,
      AWS_SESSION_TOKEN: undefined,
    }
    const previousEnv = Object.fromEntries(
      Object.keys(env).map((name) => [name, process.env[name]])
    )
    const previousExitCode = process.exitCode
    const info = spyOn(console, "info").mockImplementation(() => undefined)
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      setEnv(env)
      await import("../scripts/verify-direct-upload")

      expect({ exitCode: process.exitCode, errors: error.mock.calls }).toEqual({
        exitCode: previousExitCode,
        errors: [],
      })
      expect(info.mock.calls.at(-1)).toEqual(["PASS: direct upload verification and cleanup"])
    } finally {
      setEnv(previousEnv)
      process.exitCode = previousExitCode
      info.mockRestore()
      error.mockRestore()
    }
  }, 15_000)
})

function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
