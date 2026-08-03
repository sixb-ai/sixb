import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "@sixb/core/errors"

export interface RedisBrokerErrorOptions extends SixbErrorOptions {
  /** Narrows the failure past the module default; most callers leave this alone. */
  readonly code?: Extract<SixbErrorCode, `broker.${string}`>
}

/** A Redis Streams broker failure, prefixed and defaulted to `broker.unavailable`. */
export function redisBrokerError(
  message: string,
  options: RedisBrokerErrorOptions = {}
): SixbError {
  return new SixbError(options.code ?? "broker.unavailable", `[RedisBroker] ${message}`, options)
}
