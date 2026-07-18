export type MaterializationConflictKind =
  | "idempotency"
  | "ontology-revision"
  | "projection-fence"
  | "source-generation"
  | "effective-state"
  | "timeseries-point"
  | "outbox-lease"

function prefixMessage(message: string): string {
  return message.startsWith("[Sixb]") ? message : `[Sixb] ${message}`
}

export class MaterializationValidationError extends Error {
  readonly name = "MaterializationValidationError"

  constructor(message: string) {
    super(prefixMessage(message))
  }
}

export class MaterializationConflictError extends Error {
  readonly name = "MaterializationConflictError"

  constructor(
    readonly kind: MaterializationConflictKind,
    message: string
  ) {
    super(prefixMessage(message))
  }
}

export function isMaterializationConflictError(
  error: unknown
): error is MaterializationConflictError {
  return error instanceof MaterializationConflictError
}
