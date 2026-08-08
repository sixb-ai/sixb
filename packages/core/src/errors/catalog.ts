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
  "runtime.cancelled": {
    retryable: false,
  },
} as const satisfies Readonly<Record<string, SixbErrorDefinition>>

type CatalogErrorCode = keyof typeof SIXB_ERROR_DEFINITIONS

/** Runtime counterpart of `SixbErrorCode` for internal schema boundaries. */
export const SIXB_ERROR_CODES = Object.freeze(Object.keys(SIXB_ERROR_DEFINITIONS)) as readonly [
  CatalogErrorCode,
  ...CatalogErrorCode[],
]
