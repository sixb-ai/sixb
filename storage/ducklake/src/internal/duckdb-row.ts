import { SixbError } from "@sixb/core/errors"

export type DuckDbRow = Readonly<Record<string, unknown>>

export function getString(row: DuckDbRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string") {
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] Expected DuckDB column '${key}' to be a string, got ${typeof value}.`
    )
  }

  return value
}

export function getOptionalString(row: DuckDbRow, key: string): string | undefined {
  const value = row[key]
  if (value === null || value === undefined) {
    return undefined
  }

  if (typeof value !== "string") {
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] Expected DuckDB column '${key}' to be a string, got ${typeof value}.`
    )
  }

  return value
}

export function getBoolean(row: DuckDbRow, key: string): boolean {
  const value = row[key]
  if (typeof value !== "boolean") {
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] Expected DuckDB column '${key}' to be a boolean, got ${typeof value}.`
    )
  }

  return value
}

export function getBigIntLike(row: DuckDbRow, key: string): bigint {
  const value = row[key]
  if (typeof value === "bigint") {
    return value
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value)
  }

  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value)
  }

  throw new SixbError(
    "storage.lake_failed",
    `[SixbDuckLake] Expected DuckDB column '${key}' to be an integer, got ${typeof value}.`
  )
}

export function getOptionalBigIntLike(row: DuckDbRow, key: string): bigint | undefined {
  const value = row[key]
  if (value === null || value === undefined) {
    return undefined
  }

  return getBigIntLike(row, key)
}

export function getDate(row: DuckDbRow, key: string): Date {
  const value = row[key]
  if (value instanceof Date) {
    return value
  }

  if (typeof value === "string") {
    return new Date(value)
  }

  throw new SixbError(
    "storage.lake_failed",
    `[SixbDuckLake] Expected DuckDB column '${key}' to be a date, got ${typeof value}.`
  )
}
