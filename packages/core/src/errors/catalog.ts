interface SixbErrorDefinition {
  readonly publicMessage: string
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
    publicMessage: "Dataset not found.",
    retryable: false,
  },
  "dataset.version_not_found": {
    publicMessage: "Dataset version not found.",
    retryable: false,
  },
  "internal.unexpected": {
    publicMessage: "An unexpected internal error occurred.",
    retryable: false,
  },
  "runtime.cancelled": {
    publicMessage: "Execution was cancelled.",
    retryable: false,
  },
} as const satisfies Readonly<Record<string, SixbErrorDefinition>>

type CatalogErrorCode = keyof typeof SIXB_ERROR_DEFINITIONS

/** Runtime counterpart of `SixbErrorCode` for internal schema boundaries. */
export const SIXB_ERROR_CODES = Object.freeze(Object.keys(SIXB_ERROR_DEFINITIONS)) as readonly [
  CatalogErrorCode,
  ...CatalogErrorCode[],
]
