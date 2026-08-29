export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed")
}

export function isForeignKeyConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")
}
