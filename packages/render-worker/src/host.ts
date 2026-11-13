import type { BlobStorage, SandboxFactory, Storage } from "@sixb/core"

/** What a render reads, opens and keeps: the project's artifacts, blobs and sandboxes. */
export interface RenderHost {
  readonly id: string
  readonly storage: Pick<Storage, "artifacts">
  readonly blobStorage: Pick<BlobStorage, "put" | "open">
  /** A project without sandboxes renders nothing. */
  readonly sandboxes?: Pick<SandboxFactory, "create">
}
