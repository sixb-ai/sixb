import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "@sixb/core/errors"

export interface NatsBrokerErrorOptions extends SixbErrorOptions {
  /** Narrows the failure past the module default; most callers leave this alone. */
  readonly code?: Extract<SixbErrorCode, `broker.${string}`>
}

/** A NATS JetStream broker failure, prefixed and defaulted to `broker.unavailable`. */
export function natsBrokerError(message: string, options: NatsBrokerErrorOptions = {}): SixbError {
  return new SixbError(options.code ?? "broker.unavailable", `[NatsBroker] ${message}`, options)
}
