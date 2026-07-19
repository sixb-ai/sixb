function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return "Unknown thrown value"
  }
}

/** Preserve native errors and safely wrap arbitrary thrown values. */
export function normalizeReportedError(value: unknown): Error {
  if (value instanceof Error) {
    return value
  }

  if (typeof value === "object" && value !== null) {
    let message: unknown
    let name: unknown
    try {
      message = Reflect.get(value, "message")
      name = Reflect.get(value, "name")
    } catch {
      return new Error("Unknown thrown value")
    }

    if (typeof message === "string") {
      const error = new Error(message)
      if (typeof name === "string" && name.trim()) {
        error.name = name
      }
      return error
    }
  }

  return new Error(safeString(value))
}
