interface SixbErrorDefinition {
  readonly retryable: boolean
}

/**
 * Source of truth for stable Sixb error codes and their framework-level policy.
 *
 * Keep this catalog internal. Consumers receive the `SixbErrorCode` union and persisted
 * `SixbFailure` values, not a mutable registry.
 */
export const SIXB_ERROR_DEFINITIONS = {
  "dataset.not_found": {
    retryable: false,
  },
  "dataset.version_not_found": {
    retryable: false,
  },
  "internal.unexpected": {
    retryable: false,
  },
} as const satisfies Readonly<Record<string, SixbErrorDefinition>>
