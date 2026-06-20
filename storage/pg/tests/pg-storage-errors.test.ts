import { describe, expect, test } from "bun:test"
import { isSerializationFailure, isUniqueViolation, pgErrorCode } from "../src/storage-errors"

describe("PostgreSQL storage error classification", () => {
  test("classifies SQLSTATE serialization failures", () => {
    const error = Object.assign(new Error("could not serialize access"), { code: "40001" })

    expect(pgErrorCode(error)).toBe("40001")
    expect(isSerializationFailure(error)).toBe(true)
    expect(isUniqueViolation(error)).toBe(false)
  })

  test("does not classify unrelated errors as serialization failures", () => {
    const error = Object.assign(new Error("duplicate key value"), { code: "23505" })

    expect(isSerializationFailure(error)).toBe(false)
    expect(isUniqueViolation(error)).toBe(true)
  })
})
