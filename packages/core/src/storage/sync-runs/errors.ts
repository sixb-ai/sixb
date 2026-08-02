import { SixbError, type SixbErrorOptions } from "../../errors"

/** Sync-run storage refusing a read or a write. */
export type SyncRunErrorCode = "sync.run_not_found" | "storage.conflict" | "runtime.invalid_input"

export class SyncRunError extends SixbError {
  override readonly name = "SyncRunError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this store's set.
  constructor(code: SyncRunErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}
