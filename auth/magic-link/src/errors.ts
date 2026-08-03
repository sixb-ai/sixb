import { SixbError, type SixbErrorOptions } from "@sixb/core/errors"

/**
 * The project's `magicLink(...)` options are wrong; no sign-in attempt can fix it. Always
 * `runtime.invalid_definition`.
 */
export function magicLinkError(message: string, options?: SixbErrorOptions): SixbError {
  return new SixbError("runtime.invalid_definition", `[Sixb] ${message}`, options)
}
