import { assertProviderAccess } from "../authorization"
import type { ExecutionContext } from "../execution"
import type { SixbRuntimeContext } from "../runtime/types"
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
  openRange?(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>>
  createUpload?(input: CreateBlobUploadInput): Promise<BlobUploadSession>
  signUploadPart?(input: SignBlobUploadPartInput): Promise<SignedBlobUploadPart>
  completeUpload?(input: CompleteBlobUploadInput): Promise<FileRef>
  abortUpload?(input: AbortBlobUploadInput): Promise<void>
}

export function createBlobsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  blobStorage: BlobStorage
): BlobsRuntime {
  const assertAccess = () => assertProviderAccess(runtime, execution, "blobs.access")
  const executionBlobs: BlobsRuntime = {
    put: (input) => {
      assertAccess()
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
      return blobStorage.createUpload(input)
    }
    executionBlobs.signUploadPart = (input) => {
      assertAccess()
      return blobStorage.signUploadPart(input)
    }
    executionBlobs.completeUpload = (input) => {
      assertAccess()
      return blobStorage.completeUpload(input)
    }
    executionBlobs.abortUpload = (input) => {
      assertAccess()
      return blobStorage.abortUpload(input)
    }
  }

  return Object.freeze(executionBlobs)
}
