import { assertPrivileged } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { BlobsRuntime } from "./runtime"

/** Blob operations available only to trusted or explicitly auth-disabled executions. */
export type ExecutionBlobsRuntime = Omit<BlobsRuntime, "close">

export function createExecutionBlobsRuntime(
  runtime: SixbRuntimeContext,
  blobs: BlobsRuntime
): ExecutionBlobsRuntime {
  const assertAccess = () => assertPrivileged(runtime, "blobs.access")
  const executionBlobs: ExecutionBlobsRuntime = {
    put: (input) => {
      assertAccess()
      return blobs.put(input)
    },
    open: (blobId) => {
      assertAccess()
      return blobs.open(blobId)
    },
    stat: (blobId) => {
      assertAccess()
      return blobs.stat(blobId)
    },
  }

  const openRange = blobs.openRange?.bind(blobs)
  if (openRange) {
    executionBlobs.openRange = (blobId, range) => {
      assertAccess()
      return openRange(blobId, range)
    }
  }
  const createUpload = blobs.createUpload?.bind(blobs)
  if (createUpload) {
    executionBlobs.createUpload = (input) => {
      assertAccess()
      return createUpload(input)
    }
  }
  const signUploadPart = blobs.signUploadPart?.bind(blobs)
  if (signUploadPart) {
    executionBlobs.signUploadPart = (input) => {
      assertAccess()
      return signUploadPart(input)
    }
  }
  const completeUpload = blobs.completeUpload?.bind(blobs)
  if (completeUpload) {
    executionBlobs.completeUpload = (input) => {
      assertAccess()
      return completeUpload(input)
    }
  }
  const abortUpload = blobs.abortUpload?.bind(blobs)
  if (abortUpload) {
    executionBlobs.abortUpload = (input) => {
      assertAccess()
      return abortUpload(input)
    }
  }

  return executionBlobs
}
