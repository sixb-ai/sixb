import { randomUUID } from "node:crypto"
import { computeBlobDigest } from "@sixb/core/blob-storage/server"
import { S3BlobStorage } from "../src/s3-blob-storage"

// Run separately by an operator or trusted CI with the provider's normal S3_* environment.
// Never log credentials or signed URLs. Only touch this run's random, isolated key prefix.
const basePath = `sixb-upload-verification/${randomUUID()}`
const storage = new S3BlobStorage({ basePath })
const body = new Uint8Array(10 * 1024 * 1024).fill(42)
body.set(new TextEncoder().encode("%PDF-1.7\nSixb upload verification\n"))
const digest = computeBlobDigest(body)
const finalKey = `${basePath}/blobs/sha256/${digest.slice("sha256:".length)}`
const stagedKeys: string[] = []
let succeeded = false
try {
  for (const tampered of [false, true]) {
    const upload = await storage.createUpload({
      uploadId: `upload_${randomUUID().replaceAll("-", "")}`,
      fileName: "verification.pdf",
      mediaType: "application/pdf",
      expectedDigest: digest,
      sizeBytes: body.length,
      expiresAt: new Date(Date.now() + 300_000),
    })
    if (upload.strategy !== "direct-put") throw new Error("Expected direct PUT")
    stagedKeys.push(upload.stagingKey)
    const sent = body.slice()
    if (tampered) sent[sent.length - 1] ^= 1
    const response = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: sent,
    })
    if (tampered && response.status === 400 && (await response.text()).includes("BadDigest")) {
      console.info("PASS: storage rejected altered bytes during PUT")
      continue
    }
    if (!response.ok) throw new Error(`Direct PUT failed with HTTP ${response.status}`)
    const complete = () =>
      storage.completeUpload({
        uploadId: upload.uploadId,
        stagingKey: upload.stagingKey,
        expectedDigest: digest,
        expectedSizeBytes: body.length,
        fileName: "verification.pdf",
        mediaType: "application/pdf",
      })
    if (tampered) {
      let rejected = false
      try {
        await complete()
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("checksum mismatch")) throw error
        rejected = true
      }
      if (!rejected) throw new Error("Integrity failure: completion accepted altered bytes")
      console.info("PASS: completion rejected altered bytes")
    } else {
      const ref = await complete()
      const downloaded = await new Response(await storage.open(ref.blobId)).bytes()
      if (
        ref.digest !== digest ||
        downloaded.length !== body.length ||
        computeBlobDigest(downloaded) !== digest
      ) {
        throw new Error("Stored bytes do not match uploaded bytes")
      }
      console.info("PASS: 10 MiB direct PUT → complete → read, identical SHA-256")
    }
  }
  // A failed second upload must not corrupt the previously verified content-addressed blob.
  const finalBytes = await new Response(
    await storage.open(`blob_${digest.slice("sha256:".length)}`)
  ).bytes()
  if (computeBlobDigest(finalBytes) !== digest)
    throw new Error("Rejected upload corrupted existing blob")
  succeeded = true
} finally {
  // Final keys are also safe to delete here: basePath is unique to this synthetic verification.
  const cleanup = await Promise.allSettled(
    [...stagedKeys, finalKey].map((stagingKey) =>
      storage.abortUpload({ uploadId: "verification-cleanup", stagingKey })
    )
  )
  if (cleanup.some((result) => result.status === "rejected")) {
    console.error(`Cleanup incomplete; remove only the test prefix: ${basePath}`)
    process.exitCode = 1
  }
}
if (succeeded && process.exitCode !== 1)
  console.info("PASS: direct upload verification and cleanup")
