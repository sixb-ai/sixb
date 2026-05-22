/**
 * Base error for sync-run storage operations. Callers can use this to catch
 * domain-specific failures without relying on message text.
 */
export class SyncRunError extends Error {
  readonly name = "SyncRunError"
}
