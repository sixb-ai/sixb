export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const code = (error as { readonly code?: unknown }).code
  return code === "23505" || /duplicate key value|unique/i.test(error.message)
}
