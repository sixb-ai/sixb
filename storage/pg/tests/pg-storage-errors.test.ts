import { describe, expect, test } from "bun:test"
import {
  isRetryableTransactionConflict,
  isUniqueViolation,
  pgErrorCode,
} from "../src/storage-errors"

function pgError(code: string): Error {
  return Object.assign(new Error(`sqlstate ${code}`), { code })
}

describe("PostgreSQL storage error classification", () => {
  test("classifies SQLSTATE serialization failures (40001) as retryable", () => {
    const error = pgError("40001")

    expect(pgErrorCode(error)).toBe("40001")
    expect(isRetryableTransactionConflict(error)).toBe(true)
    expect(isUniqueViolation(error)).toBe(false)
  })

  test("classifies SQLSTATE deadlocks (40P01) as retryable", () => {
    const error = pgError("40P01")

    expect(pgErrorCode(error)).toBe("40P01")
    expect(isRetryableTransactionConflict(error)).toBe(true)
  })

  test("does not retry other class-40 rollbacks or unrelated errors", () => {
    // 40002/40003 are class-40 but not safe to blindly replay; 23505 is a plain constraint
    // violation. Pinning these locks the exclusion decision so it cannot silently widen.
    expect(isRetryableTransactionConflict(pgError("40002"))).toBe(false)
    expect(isRetryableTransactionConflict(pgError("40003"))).toBe(false)

    const unique = pgError("23505")
    expect(isRetryableTransactionConflict(unique)).toBe(false)
    expect(isUniqueViolation(unique)).toBe(true)
  })
})
