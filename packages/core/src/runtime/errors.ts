/**
 * Thrown for runtime setup, lifecycle, and internal invariant failures
 * that are not validation errors (e.g., duplicate registrations, missing
 * bootstrap resources, failed event appends, module load failures).
 */
export class RuntimeError extends Error {
  readonly name = "RuntimeError"
}
