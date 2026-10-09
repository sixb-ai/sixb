import { assertProviderAccess } from "../authorization"
import type { ExecutionContext } from "../execution"
import type { SixbRuntimeContext } from "../runtime/types"
import {
  type CreateFileDownloadUrlOptions,
  createFileDownloadUrl,
  type FileDownloadUrl,
  type FileDownloadUrlContext,
  revokeFileDownloadUrl,
} from "./download-urls"
import { canonicalMediaType } from "./media-type"
import type {
  AbortBlobUploadInput,
  BlobByteRange,
  BlobInfo,
  BlobStorage,
  BlobUploadSession,
  CompleteBlobUploadInput,
  CreateBlobUploadInput,
  FileRef,
  PutBlobInput,
  SignBlobUploadPartInput,
  SignedBlobUploadPart,
} from "./types"
import { supportsDirectUpload, supportsRangeRead } from "./validation"

/** Blob operations bound to one execution. Provider lifecycle is deliberately host-only. */
export interface BlobsRuntime {
  put(input: PutBlobInput): Promise<FileRef>
  open(blobId: string): Promise<ReadableStream<Uint8Array>>
  stat(blobId: string): Promise<BlobInfo | null>
  /**
   * A URL anyone can use to read this file until it expires or is revoked, for services that
   * fetch media themselves. Requires the API's public origin (`SIXB_API_PUBLIC_ORIGIN`).
   */
  createDownloadUrl(file: FileRef, options?: CreateFileDownloadUrlOptions): Promise<FileDownloadUrl>
  /** Stop a URL from `createDownloadUrl()` before it expires. */
  revokeDownloadUrl(id: string): Promise<void>
  openRange?(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>>
  createUpload?(input: CreateBlobUploadInput): Promise<BlobUploadSession>
  signUploadPart?(input: SignBlobUploadPartInput): Promise<SignedBlobUploadPart>
  completeUpload?(input: CompleteBlobUploadInput): Promise<FileRef>
  abortUpload?(input: AbortBlobUploadInput): Promise<void>
}

export function createBlobsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  blobStorage: BlobStorage,
  apiPublicOrigin: () => string | undefined
): BlobsRuntime {
  const assertAccess = () => assertProviderAccess(runtime, execution, "blobs.access")
  // Read the origin per call: the server or CLI may record it after this SDK was bound.
  const downloadUrlContext = (): FileDownloadUrlContext => ({
    projectId: runtime.projectId,
    storage: runtime.storage,
    blobStorage,
    executionId: execution.id,
    apiPublicOrigin: apiPublicOrigin(),
  })
  const executionBlobs: BlobsRuntime = {
    put: (input) => {
      assertAccess()
      assertMediaType("put", input.mediaType)
      return blobStorage.put(input)
    },
    open: (blobId) => {
      assertAccess()
      return blobStorage.open(blobId)
    },
    stat: (blobId) => {
      assertAccess()
      return blobStorage.stat(blobId)
    },
    createDownloadUrl: async (file, options) => {
      assertAccess()
      return createFileDownloadUrl(downloadUrlContext(), file, options)
    },
    revokeDownloadUrl: async (id) => {
      assertAccess()
      return revokeFileDownloadUrl(downloadUrlContext(), id)
    },
  }

  if (supportsRangeRead(blobStorage)) {
    executionBlobs.openRange = (blobId, range) => {
      assertAccess()
      return blobStorage.openRange(blobId, range)
    }
  }
  if (supportsDirectUpload(blobStorage)) {
    executionBlobs.createUpload = (input) => {
      assertAccess()
      assertMediaType("createUpload", input.mediaType)
      return blobStorage.createUpload(input)
    }
    executionBlobs.signUploadPart = (input) => {
      assertAccess()
      return blobStorage.signUploadPart(input)
    }
    executionBlobs.completeUpload = (input) => {
      assertAccess()
      assertMediaType("completeUpload", input.mediaType)
      return blobStorage.completeUpload(input)
    }
    executionBlobs.abortUpload = (input) => {
      assertAccess()
      return blobStorage.abortUpload(input)
    }
  }

  return Object.freeze(executionBlobs)
}

function assertMediaType(method: string, mediaType: string | undefined): void {
  if (mediaType !== undefined && canonicalMediaType(mediaType) === null) {
    throw new Error(
      `[Sixb] blobs.${method}() mediaType must be one media type, such as "application/pdf". Received ${JSON.stringify(mediaType)}.`
    )
  }
}
