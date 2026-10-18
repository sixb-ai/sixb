import { expect, test } from "bun:test"
import {
  isConnectionLost,
  isRetryableTransactionConflict,
  isUniqueViolation,
  pgErrorCode,
} from "../src/storage-errors"

// Only serialization failures and deadlocks are safe to replay: 40002/40003 are class 40 too.
// A statement error leaves the session alive (it only aborts the transaction), and a refused
// connect never had a session: neither may skip ROLLBACK nor keep a connection out of the pool.
test.each([
  ["40001", undefined, { retryable: true, unique: false, lost: false }],
  ["40P01", undefined, { retryable: true, unique: false, lost: false }],
  ["40002", undefined, { retryable: false, unique: false, lost: false }],
  ["40003", undefined, { retryable: false, unique: false, lost: false }],
  ["23505", "ERROR", { retryable: false, unique: true, lost: false }],
  ["57014", "ERROR", { retryable: false, unique: false, lost: false }],
  ["ECONNREFUSED", undefined, { retryable: false, unique: false, lost: false }],
  ["CONNECTION_CLOSED", undefined, { retryable: false, unique: false, lost: true }],
  ["ECONNRESET", undefined, { retryable: false, unique: false, lost: true }],
  ["57P01", "FATAL", { retryable: false, unique: false, lost: true }],
  ["XX000", "PANIC", { retryable: false, unique: false, lost: true }],
])("classifies PostgreSQL error %s (%s)", (code, severity, expected) => {
  const error = Object.assign(new Error(`sqlstate ${code}`), { code, severity })

  expect(pgErrorCode(error)).toBe(code)
  expect({
    retryable: isRetryableTransactionConflict(error),
    unique: isUniqueViolation(error),
    lost: isConnectionLost(error),
  }).toEqual(expected)
})
