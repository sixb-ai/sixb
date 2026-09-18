import { createHash } from "node:crypto"
import type { BlockBlobClient } from "@azure/storage-blob"
import {
  type AbortBlobUploadInput,
  assertExpectedBlobSize,
  assertValidExpectedBlobSize,
  type BlobDigest,
  type BlobInfo,
  BlobStorageError,
  type BlobUploadSession,
  blobIdFromDigest,
  type CompleteBlobUploadInput,
  type CreateBlobUploadInput,
  type FileRef,
  type SignBlobUploadPartInput,
  type SignedBlobUploadPart,
} from "@sixb/core/blob-storage/server"
import { azureErrorCode, type createAzureClient, webStream } from "./azure-client"
import {
  isSha256,
  readUploadRecord,
  requireUploadIdentity,
  type UploadRecord,
  writeUploadRecord,
} from "./upload-sessions"

interface DirectUploadOptions {
  readonly partSizeBytes: number
  readonly multipartThresholdBytes: number
  readonly client: ReturnType<typeof createAzureClient>
  readonly key: (suffix: string) => string
  readonly maxSizeBytes: number
  readonly concurrency: number
  readonly timeoutMillis: number
  readonly publish: (
    source: BlockBlobClient,
    info: BlobInfo,
    signal: AbortSignal,
    etag: string
  ) => Promise<void>
}

/** Browser writes only the object; its sibling session record is server-owned. */
export class AzureDirectUploads {
  private activeCompletions = 0

  constructor(private readonly options: DirectUploadOptions) {}

  async create(input: CreateBlobUploadInput): Promise<BlobUploadSession> {
    const stagingKey = this.stagingKey(input.uploadId)
    const identity = this.validateIdentity(input.expectedDigest, input.sizeBytes)
    const expiresAt = input.expiresAt.getTime()
    const now = Date.now()
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 60 * 60 * 1000) {
      throw new BlobStorageError("[BlobAzure] Upload expiry must be in the next hour.")
    }
    const expiry = new Date(expiresAt)
    const multipart = identity.sizeBytes > this.options.multipartThresholdBytes
    // Sign before recording: a credential failure leaves no unusable pending session.
    const url = multipart
      ? undefined
      : await this.options.client.signUpload(this.blob(stagingKey), expiry)
    const record: UploadRecord = {
      version: 1,
      ...identity,
      expiresAt,
      status: "pending",
      ...(multipart ? { partSizeBytes: this.options.partSizeBytes } : {}),
    }
    await writeUploadRecord(this.session(input.uploadId), record)
    if (url === undefined)
      return {
        strategy: "multipart",
        partReceipt: "none",
        uploadId: input.uploadId,
        stagingKey,
        providerUploadId: input.uploadId,
        partSizeBytes: this.options.partSizeBytes,
        expiresAt: expiry,
      }
    return {
      strategy: "direct-put",
      uploadId: input.uploadId,
      method: "PUT",
      url,
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/octet-stream" },
      expiresAt: expiry,
      stagingKey,
    }
  }

  async signPart(input: SignBlobUploadPartInput): Promise<SignedBlobUploadPart> {
    this.validateSession(input)
    const stored = await readUploadRecord(this.session(input.uploadId))
    const record = stored?.record
    if (!record?.partSizeBytes || record.status !== "pending" || record.expiresAt <= Date.now()) {
      throw new BlobStorageError("[BlobAzure] No active multipart session.")
    }
    if (
      input.providerUploadId !== input.uploadId ||
      !Number.isSafeInteger(input.partNumber) ||
      input.partNumber < 1 ||
      input.partNumber > Math.ceil(record.sizeBytes / record.partSizeBytes)
    ) {
      throw new BlobStorageError("[BlobAzure] Invalid multipart part number or provider upload id.")
    }
    const expiresAt = new Date(Math.min(input.expiresAt.getTime(), record.expiresAt))
    if (!Number.isSafeInteger(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
      throw new BlobStorageError("[BlobAzure] Part expiry must be in the future.")
    const blockId = uploadBlockId(input.partNumber)
    const url = new URL(
      await this.options.client.signUpload(this.blob(input.stagingKey), expiresAt)
    )
    url.searchParams.set("comp", "block")
    url.searchParams.set("blockid", blockId)
    return {
      partNumber: input.partNumber,
      method: "PUT",
      url: url.toString(),
      headers: { "content-type": "application/octet-stream" },
      expiresAt,
    }
  }

  async complete(input: CompleteBlobUploadInput): Promise<FileRef> {
    this.validateSession(input)
    const identity = this.validateIdentity(input.expectedDigest, input.expectedSizeBytes)
    if (this.activeCompletions >= this.options.concurrency) {
      throw new BlobStorageError(
        "[BlobAzure] Completion capacity reached; retry this upload later."
      )
    }
    this.activeCompletions++
    const signal = AbortSignal.timeout(this.options.timeoutMillis)
    const session = this.session(input.uploadId)
    try {
      const stored = await readUploadRecord(session, signal)
      if (!stored) throw new BlobStorageError("[BlobAzure] Upload session was not found.")
      const { record, etag: sessionEtag } = stored
      requireUploadIdentity(record, identity.digest, identity.sizeBytes)
      validateParts(record, input)
      if (record.status === "aborted") throw new BlobStorageError("[BlobAzure] Upload was aborted.")
      const info: BlobInfo = {
        blobId: blobIdFromDigest(record.digest),
        digest: record.digest,
        sizeBytes: record.sizeBytes,
      }
      if (record.status !== "completed") {
        if (record.expiresAt <= Date.now())
          throw new BlobStorageError("[BlobAzure] Upload has expired.")
        const source = this.blob(input.stagingKey)
        if (record.partSizeBytes) {
          await assembleUpload(source, record.sizeBytes, record.partSizeBytes, signal)
        }
        const properties = await source.getProperties({ abortSignal: signal })
        if (properties.blobType !== "BlockBlob" || properties.contentEncoding || !properties.etag) {
          throw new BlobStorageError(
            "[BlobAzure] Upload must be a block blob without content encoding."
          )
        }
        assertExpectedBlobSize(record.sizeBytes, properties.contentLength ?? -1, "BlobAzure")
        await verifyUpload(source, info, properties.etag, signal)
        await this.options.publish(source, info, signal, properties.etag)
        try {
          await writeUploadRecord(session, { ...record, status: "completed" }, sessionEtag, signal)
        } catch (error) {
          // Another completion may have won. An abort wins over an in-flight
          // completion's receipt, even if verified content has already been stored.
          if (azureErrorCode(error) !== "ConditionNotMet") throw error
          const latest = await readUploadRecord(session, signal)
          if (!latest || latest.record.status !== "completed") {
            throw new BlobStorageError("[BlobAzure] Upload was aborted during completion.")
          }
          requireUploadIdentity(latest.record, info.digest, info.sizeBytes)
        }
        // The durable receipt precedes deletion, so retries do not trust a
        // caller-declared hash merely because some final blob already exists.
        await this.deleteStaging(source, properties.etag, signal)
      }
      return reference(record, input)
    } catch (error) {
      // A concurrent completion can delete staging while this call is reading or
      // copying it. Only a durable, matching receipt makes that failure a success.
      if (!signal.aborted) {
        const latest = await readUploadRecord(session, signal).catch(() => null)
        if (latest?.record.status === "completed") {
          requireUploadIdentity(latest.record, identity.digest, identity.sizeBytes)
          validateParts(latest.record, input)
          return reference(latest.record, input)
        }
      }
      throw error
    } finally {
      this.activeCompletions--
    }
  }

  async abort(input: AbortBlobUploadInput): Promise<void> {
    this.validateSession(input)
    const session = this.session(input.uploadId)
    const stored = await readUploadRecord(session)
    if (stored?.record.status === "completed") {
      throw new BlobStorageError("[BlobAzure] Completed uploads cannot be aborted.")
    }
    if (stored?.record.status === "pending") {
      try {
        await writeUploadRecord(session, { ...stored.record, status: "aborted" }, stored.etag)
      } catch (error) {
        if (azureErrorCode(error) !== "ConditionNotMet") throw error
        const latest = await readUploadRecord(session)
        if (latest?.record.status !== "aborted") throw error
      }
    }
    await this.blob(input.stagingKey).deleteIfExists()
  }

  private validateIdentity(
    digest: unknown,
    size: number | undefined
  ): { digest: BlobDigest; sizeBytes: number } {
    if (!isSha256(digest) || size === undefined) {
      throw new BlobStorageError("[BlobAzure] Direct uploads require a SHA-256 digest and size.")
    }
    assertValidExpectedBlobSize(size, "BlobAzure")
    if (size > this.options.maxSizeBytes) {
      throw new BlobStorageError(
        `[BlobAzure] Direct upload exceeds the ${this.options.maxSizeBytes} byte limit.`
      )
    }
    return { digest, sizeBytes: size }
  }

  private validateSession(input: AbortBlobUploadInput): void {
    if (
      input.stagingKey !== this.stagingKey(input.uploadId) ||
      (input.providerUploadId !== undefined && input.providerUploadId !== input.uploadId)
    ) {
      throw new BlobStorageError("[BlobAzure] Invalid upload staging key or provider upload id.")
    }
  }

  private stagingKey(uploadId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(uploadId)) {
      throw new BlobStorageError("[BlobAzure] Invalid upload id.")
    }
    return this.options.key(`uploads/${uploadId}/object`)
  }

  private session(uploadId: string): BlockBlobClient {
    return this.blob(this.options.key(`uploads/${uploadId}/session.json`))
  }

  private blob(key: string): BlockBlobClient {
    return this.options.client.container.getBlockBlobClient(key)
  }

  private async deleteStaging(
    blob: BlockBlobClient,
    etag: string,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await blob.deleteIfExists({ conditions: { ifMatch: etag }, abortSignal: signal })
    } catch (error) {
      if (azureErrorCode(error) === "ConditionNotMet") return
      console.warn("[BlobAzure] Failed to clean completed upload staging.", error)
    }
  }
}

function uploadBlockId(partNumber: number): string {
  return Buffer.from(String(partNumber).padStart(6, "0")).toString("base64")
}

function validateParts(record: UploadRecord, input: CompleteBlobUploadInput): void {
  if (!record.partSizeBytes) {
    if (input.providerUploadId !== undefined || input.parts?.length)
      throw new BlobStorageError(
        "[BlobAzure] Single-PUT sessions do not accept multipart receipts."
      )
    return
  }
  const count = Math.ceil(record.sizeBytes / record.partSizeBytes)
  if (
    input.providerUploadId !== input.uploadId ||
    input.parts?.length !== count ||
    input.parts.some((part, index) => part.partNumber !== index + 1 || part.etag !== undefined)
  ) {
    throw new BlobStorageError(
      "[BlobAzure] Multipart receipts must contain every ordered block exactly once."
    )
  }
}

async function assembleUpload(
  source: BlockBlobClient,
  sizeBytes: number,
  partSize: number,
  signal: AbortSignal
): Promise<void> {
  // A committed staging object is immutable to our completion attempts. Concurrent
  // callers and retries verify that same object rather than recommitting blocks.
  if (await source.exists({ abortSignal: signal })) return
  const count = Math.ceil(sizeBytes / partSize)
  const list = await source.getBlockList("uncommitted", { abortSignal: signal })
  const blocks = new Map(list.uncommittedBlocks?.map((block) => [block.name, block.size]))
  const ids = Array.from({ length: count }, (_, index) => uploadBlockId(index + 1))
  for (const [index, id] of ids.entries()) {
    if (blocks.get(id) !== Math.min(partSize, sizeBytes - index * partSize)) {
      // Another completion may have committed between exists() and getBlockList().
      if (await source.exists({ abortSignal: signal })) return
      throw new BlobStorageError("[BlobAzure] Multipart block is missing or has an incorrect size.")
    }
  }
  try {
    await source.commitBlockList(ids, { abortSignal: signal, conditions: { ifNoneMatch: "*" } })
  } catch (error) {
    if (
      azureErrorCode(error) !== "BlobAlreadyExists" &&
      azureErrorCode(error) !== "ConditionNotMet"
    )
      throw error
  }
}

function reference(record: UploadRecord, input: CompleteBlobUploadInput): FileRef {
  return {
    blobId: blobIdFromDigest(record.digest),
    digest: record.digest,
    sizeBytes: record.sizeBytes,
    ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    ...(input.logicalPath === undefined ? {} : { logicalPath: input.logicalPath }),
  }
}

async function verifyUpload(
  source: BlockBlobClient,
  info: BlobInfo,
  etag: string,
  signal: AbortSignal
) {
  const response = await source.download(0, undefined, {
    abortSignal: signal,
    conditions: { ifMatch: etag },
  })
  const hash = createHash("sha256")
  let sizeBytes = 0
  await webStream(response.readableStreamBody).pipeTo(
    new WritableStream<Uint8Array>({
      write(bytes) {
        sizeBytes += bytes.byteLength
        if (sizeBytes > info.sizeBytes)
          assertExpectedBlobSize(info.sizeBytes, sizeBytes, "BlobAzure")
        hash.update(bytes)
      },
    }),
    { signal }
  )
  assertExpectedBlobSize(info.sizeBytes, sizeBytes, "BlobAzure")
  if (`sha256:${hash.digest("hex")}` !== info.digest) {
    throw new BlobStorageError(
      "[BlobAzure] Uploaded bytes do not match the expected SHA-256 digest."
    )
  }
}
