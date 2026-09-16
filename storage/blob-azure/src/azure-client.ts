import { Readable } from "node:stream"
import { DefaultAzureCredential } from "@azure/identity"
import {
  BlobSASPermissions,
  BlobServiceClient,
  type BlockBlobClient,
  type ContainerClient,
  type HttpAuthorization,
  type StoragePipelineOptions,
  StorageSharedKeyCredential,
} from "@azure/storage-blob"
import { BlobStorageError } from "@sixb/core/blob-storage/server"
import type { AzureBlobStorageOptions } from "./types"
import { uploadSigner } from "./upload-signing"

export function azureErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  if ("details" in error && typeof error.details === "object" && error.details !== null) {
    if ("errorCode" in error.details && typeof error.details.errorCode === "string") {
      return error.details.errorCode
    }
  }
  return "code" in error && typeof error.code === "string" ? error.code : undefined
}

interface AzureClient {
  readonly container: ContainerClient
  signUpload(blob: BlockBlobClient, expiresAt: Date): Promise<string>
  copySource(
    blob: BlockBlobClient,
    signal?: AbortSignal
  ): Promise<{
    readonly url: string
    readonly sourceAuthorization?: HttpAuthorization
  }>
}

export function createAzureClient(options: AzureBlobStorageOptions, retries: number): AzureClient {
  if (!options.container.trim()) {
    throw new BlobStorageError("[BlobAzure] container must not be empty.")
  }
  const pipeline: StoragePipelineOptions = {
    retryOptions: { maxTries: retries + 1, tryTimeoutInMs: 30_000 },
  }

  if (options.connectionString !== undefined) {
    if (
      options.credential ||
      options.accountName !== undefined ||
      options.serviceUrl !== undefined
    ) {
      throw new BlobStorageError(
        "[BlobAzure] connectionString cannot be combined with accountName, serviceUrl, or credential."
      )
    }
    const service = BlobServiceClient.fromConnectionString(options.connectionString, pipeline)
    // Publication reads private staging through a short-lived read SAS. A SAS-only
    // connection string cannot sign that URL, so reject it before consuming bytes.
    if (!(service.credential instanceof StorageSharedKeyCredential)) {
      throw new BlobStorageError("[BlobAzure] connectionString must contain an account key.")
    }
    return {
      container: service.getContainerClient(options.container),
      signUpload: uploadSigner(service),
      async copySource(blob: BlockBlobClient, signal?: AbortSignal) {
        signal?.throwIfAborted()
        const now = Date.now()
        return {
          url: await blob.generateSasUrl({
            permissions: BlobSASPermissions.parse("r"),
            startsOn: new Date(now - 5 * 60 * 1000),
            expiresOn: new Date(now + 60 * 60 * 1000),
          }),
        }
      },
    }
  }

  if ((options.accountName === undefined) === (options.serviceUrl === undefined)) {
    throw new BlobStorageError("[BlobAzure] Specify exactly one of accountName or serviceUrl.")
  }
  if (options.accountName !== undefined && !/^[a-z0-9]{3,24}$/.test(options.accountName)) {
    throw new BlobStorageError("[BlobAzure] accountName must be 3–24 lowercase letters or digits.")
  }
  const url = new URL(options.serviceUrl ?? `https://${options.accountName}.blob.core.windows.net`)
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) {
    throw new BlobStorageError(
      "[BlobAzure] serviceUrl must be HTTPS without credentials or a query."
    )
  }
  const credential = options.credential ?? new DefaultAzureCredential()
  const service = new BlobServiceClient(url.toString(), credential, pipeline)
  return {
    container: service.getContainerClient(options.container),
    signUpload: uploadSigner(service),
    async copySource(blob: BlockBlobClient, signal?: AbortSignal) {
      const token = await credential.getToken("https://storage.azure.com/.default", {
        abortSignal: signal,
      })
      if (!token)
        throw new BlobStorageError("[BlobAzure] Could not acquire a storage access token.")
      return {
        url: blob.url,
        sourceAuthorization: { scheme: "Bearer", value: token.token },
      }
    },
  }
}

/** Node SDK streams are byte streams; preserving cancellation releases the HTTP body. */
export function webStream(stream: NodeJS.ReadableStream | undefined): ReadableStream<Uint8Array> {
  if (!(stream instanceof Readable)) {
    throw new BlobStorageError("[BlobAzure] Azure returned no readable blob body.")
  }
  return Readable.toWeb(stream, {
    strategy: {
      highWaterMark: stream.readableHighWaterMark,
      size: (chunk: Uint8Array) => chunk.byteLength,
    },
  }) as unknown as ReadableStream<Uint8Array>
}
