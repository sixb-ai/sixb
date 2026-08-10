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

export interface BlobsRuntime {
  put(input: PutBlobInput): Promise<FileRef>
  open(blobId: string): Promise<ReadableStream<Uint8Array>>
  stat(blobId: string): Promise<BlobInfo | null>
  openRange?(blobId: string, range: BlobByteRange): Promise<ReadableStream<Uint8Array>>
  createUpload?(input: CreateBlobUploadInput): Promise<BlobUploadSession>
  signUploadPart?(input: SignBlobUploadPartInput): Promise<SignedBlobUploadPart>
  completeUpload?(input: CompleteBlobUploadInput): Promise<FileRef>
  abortUpload?(input: AbortBlobUploadInput): Promise<void>
  close?(): void | Promise<void>
}

/** Expose blob operations without leaking the configured provider instance. */
export function createBlobsRuntime(storage: BlobStorage): BlobsRuntime {
  const runtime: BlobsRuntime = {
    put: (input) => storage.put(input),
    open: (blobId) => storage.open(blobId),
    stat: (blobId) => storage.stat(blobId),
    ...(storage.close ? { close: () => storage.close?.() } : {}),
  }

  if (supportsRangeRead(storage)) {
    runtime.openRange = (blobId, range) => storage.openRange(blobId, range)
  }
  if (supportsDirectUpload(storage)) {
    runtime.createUpload = (input) => storage.createUpload(input)
    runtime.signUploadPart = (input) => storage.signUploadPart(input)
    runtime.completeUpload = (input) => storage.completeUpload(input)
    runtime.abortUpload = (input) => storage.abortUpload(input)
  }

  return runtime
}
