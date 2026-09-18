import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import type { BlockBlobClient } from "@azure/storage-blob"
import {
  type AbortBlobUploadInput,
  assertExpectedBlobSize,
  assertValidExpectedBlobSize,
  type BlobByteRange,
  type BlobInfo,
  type BlobStorage,
  BlobStorageError,
  type BlobUploadSession,
  blobDigestHex,
  blobIdFromDigest,
  type CompleteBlobUploadInput,
  type CreateBlobUploadInput,
  createFileRef,
  type DirectUploadBlobStorage,
  type FileRef,
  type PutBlobInput,
  type RangeReadableBlobStorage,
  type SignBlobUploadPartInput,
  type SignedBlobUploadPart,
  streamBlobBody,
} from "@sixb/core/blob-storage/server"
import { azureErrorCode, createAzureClient, webStream } from "./azure-client"
import { MAX_BLOCKS, uploadBlocks } from "./block-upload"
import { AzureDirectUploads } from "./direct-uploads"
import type { AzureBlobStorageOptions } from "./types"

export class AzureBlobStorage
  implements BlobStorage, RangeReadableBlobStorage, DirectUploadBlobStorage
{
  private readonly client: ReturnType<typeof createAzureClient>
  private readonly basePath: string
  private readonly blockSizeBytes: number
  private readonly concurrency: number
  private readonly uploads: AzureDirectUploads

  constructor(options: AzureBlobStorageOptions) {
    this.basePath = (options.basePath ?? "sixb").split("/").filter(Boolean).join("/")
    this.blockSizeBytes = integerOption(
      "blockSizeBytes",
      options.blockSizeBytes ?? 8 * 1024 * 1024,
      1,
      100 * 1024 * 1024
    )
    this.concurrency = integerOption("concurrency", options.concurrency ?? 2, 1, 64)
    const retries = integerOption("retries", options.retries ?? 3, 0, 20)
    this.client = createAzureClient(options, retries)
    const maxSizeBytes = this.blockSizeBytes * MAX_BLOCKS
    this.uploads = new AzureDirectUploads({
      client: this.client,
      key: (suffix) => this.key(suffix),
      partSizeBytes: this.blockSizeBytes,
      multipartThresholdBytes: integerOption(
        "multipartThresholdBytes",
        options.multipartThresholdBytes ?? 32 * 1024 * 1024,
        1,
        5_000 * 1024 * 1024
      ),
      maxSizeBytes: integerOption(
        "directUploadMaxSizeBytes",
        options.directUploadMaxSizeBytes ?? Math.min(512 * 1024 * 1024, maxSizeBytes),
        1,
        maxSizeBytes
      ),
      concurrency: integerOption(
        "completionConcurrency",
        options.completionConcurrency ?? 2,
        1,
        64
      ),
      timeoutMillis: integerOption(
        "completionTimeoutMillis",
        options.completionTimeoutMillis ?? 5 * 60 * 1000,
        1,
        60 * 60 * 1000
      ),
      publish: (source, info, signal, etag) => this.publish(source, info, signal, etag),
    })
  }

  createUpload(input: CreateBlobUploadInput): Promise<BlobUploadSession> {
    return this.uploads.create(input)
  }

  completeUpload(input: CompleteBlobUploadInput): Promise<FileRef> {
    return this.uploads.complete(input)
  }

  abortUpload(input: AbortBlobUploadInput): Promise<void> {
    return this.uploads.abort(input)
  }

  signUploadPart(input: SignBlobUploadPartInput): Promise<SignedBlobUploadPart> {
    return this.uploads.signPart(input)
  }

  async put(input: PutBlobInput): Promise<FileRef> {
    assertValidExpectedBlobSize(input.expectedSizeBytes, "BlobAzure")
    if (
      input.expectedSizeBytes !== undefined &&
      input.expectedSizeBytes > this.blockSizeBytes * MAX_BLOCKS
    ) {
      throw new BlobStorageError(
        "[BlobAzure] Upload exceeds 50,000 blocks; increase blockSizeBytes."
      )
    }
    const staging = this.client.container.getBlockBlobClient(
      this.key(`uploads/${randomUUID()}/object`)
    )
    let staged = false
    try {
      const result = await uploadBlocks({
        stream: streamBlobBody(input.body),
        blockSizeBytes: this.blockSizeBytes,
        concurrency: this.concurrency,
        expectedSizeBytes: input.expectedSizeBytes,
        signal: input.signal,
        stage: async (id, bytes, signal) => {
          staged = true
          await staging.stageBlock(id, bytes, bytes.byteLength, {
            abortSignal: signal,
            transactionalContentMD5: createHash("md5").update(bytes).digest(),
          })
        },
      })
      input.signal?.throwIfAborted()
      staged = true
      await staging.commitBlockList(result.blockIds, { abortSignal: input.signal })
      const info: BlobInfo = {
        blobId: blobIdFromDigest(result.digest),
        digest: result.digest,
        sizeBytes: result.sizeBytes,
      }
      await this.publish(staging, info, input.signal)
      return createFileRef(input, info)
    } finally {
      if (staged) await this.cleanup(staging)
    }
  }

  async stat(blobId: string): Promise<BlobInfo | null> {
    return this.readInfo(blobId)
  }

  private async readInfo(blobId: string, signal?: AbortSignal): Promise<BlobInfo | null> {
    const hex = hexFromId(blobId)
    if (!hex) return null
    try {
      const properties = await this.content(hex).getProperties({ abortSignal: signal })
      const sizeBytes = properties.contentLength
      if (sizeBytes === undefined || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error(`[BlobAzure] Azure returned an invalid size for blob '${blobId}'.`)
      }
      return { blobId, digest: `sha256:${hex}`, sizeBytes }
    } catch (error) {
      if (azureErrorCode(error) === "BlobNotFound") return null
      throw error
    }
  }

  async open(blobId: string): Promise<ReadableStream<Uint8Array>> {
    return this.download(blobId)
  }

  async openRange(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>> {
    return this.download(blobId, range)
  }

  private async download(
    blobId: string,
    range?: BlobByteRange
  ): Promise<ReadableStream<Uint8Array>> {
    const hex = hexFromId(blobId)
    if (!hex) throw new BlobStorageError(`[BlobAzure] Invalid blob id '${blobId}'.`)
    try {
      const response = await this.content(hex).download(
        range?.start ?? 0,
        range === undefined ? undefined : range.endInclusive - range.start + 1
      )
      return webStream(response.readableStreamBody)
    } catch (error) {
      if (azureErrorCode(error) === "BlobNotFound") {
        throw new BlobStorageError(`[BlobAzure] Unknown blob '${blobId}'.`)
      }
      throw error
    }
  }

  private async publish(
    staging: BlockBlobClient,
    info: BlobInfo,
    signal?: AbortSignal,
    sourceEtag?: string
  ): Promise<void> {
    signal?.throwIfAborted()
    const checkSource = async () => {
      if (sourceEtag)
        await staging.getProperties({ abortSignal: signal, conditions: { ifMatch: sourceEtag } })
    }
    await checkSource()
    if (await this.alreadyPublished(info, signal)) return
    const destination = this.content(blobDigestHex(info.digest))
    const prefix = randomUUID()
    const blocks: string[] = []

    try {
      // One path for all sizes: server-side block copies followed by an atomic,
      // create-only commit. Uncommitted blocks are never visible to open/stat.
      // Backend staging is private. For browser staging, recheck its ETag after
      // all synchronous copies: a changed source must never reach the final commit.
      for (let offset = 0; offset < info.sizeBytes; offset += this.blockSizeBytes) {
        signal?.throwIfAborted()
        const id = Buffer.from(`${prefix}:${String(blocks.length).padStart(5, "0")}`).toString(
          "base64"
        )
        const source = await this.client.copySource(staging, signal)
        await destination.stageBlockFromURL(
          id,
          source.url,
          offset,
          Math.min(this.blockSizeBytes, info.sizeBytes - offset),
          {
            abortSignal: signal,
            sourceAuthorization: source.sourceAuthorization,
          }
        )
        blocks.push(id)
      }
      signal?.throwIfAborted()
      await checkSource()
      await destination.commitBlockList(blocks, {
        abortSignal: signal,
        conditions: { ifNoneMatch: "*" },
        metadata: { sha256: blobDigestHex(info.digest) },
        blobHTTPHeaders: { blobContentType: "application/octet-stream" },
      })
    } catch (error) {
      // A winning commit also discards another writer's uncommitted blocks.
      // Both the condition failure and InvalidBlockList can therefore be dedup.
      const code = azureErrorCode(error)
      if (
        (code === "ConditionNotMet" ||
          code === "BlobAlreadyExists" ||
          code === "InvalidBlockList") &&
        (await this.alreadyPublished(info, signal))
      ) {
        await checkSource()
        return
      }
      throw error
    }
  }

  private async alreadyPublished(info: BlobInfo, signal?: AbortSignal): Promise<boolean> {
    const existing = await this.readInfo(info.blobId, signal)
    if (!existing) return false
    assertExpectedBlobSize(info.sizeBytes, existing.sizeBytes, "BlobAzure")
    return true
  }

  private async cleanup(staging: BlockBlobClient): Promise<void> {
    try {
      // Put Blob clears uncommitted blocks too. Deleting an uncommitted-only
      // upload alone can return BlobNotFound and leave its blocks behind.
      await staging.upload(new Uint8Array(), 0)
      await staging.delete()
    } catch (error) {
      // Publication may already have succeeded. Lifecycle cleanup is the backstop.
      console.warn("[BlobAzure] Failed to clean upload staging.", error)
    }
  }

  private content(hex: string): BlockBlobClient {
    return this.client.container.getBlockBlobClient(this.key(`blobs/sha256/${hex}`))
  }

  private key(suffix: string): string {
    return this.basePath ? `${this.basePath}/${suffix}` : suffix
  }
}

function hexFromId(blobId: string): string | null {
  return /^blob_[a-f0-9]{64}$/.test(blobId) ? blobId.slice(5) : null
}

function integerOption(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BlobStorageError(
      `[BlobAzure] ${name} must be an integer between ${minimum} and ${maximum}.`
    )
  }
  return value
}
