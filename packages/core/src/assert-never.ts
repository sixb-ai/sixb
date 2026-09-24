/**
 * Closes a switch over a union: the call stops compiling when a new member has no case, and throws
 * if an untyped value reaches it at runtime.
 */
export function assertNever(_value: never, message: string): never {
  throw new Error(message)
}
