/**
 * Base error for action-run storage operations. Callers can use this to catch
 * domain-specific failures without relying on message text.
 */
export class ActionRunError extends Error {
  readonly name = "ActionRunError"
}
