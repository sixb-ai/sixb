import { describe, expect, test } from "bun:test"
import {
  captureSixbFailure,
  createSixbError,
  parseSixbFailure,
  serializeSixbFailure,
  toSixbFailure,
} from "../src/errors/internal"
import { SYNC_RUN_FAILURE_CODES } from "../src/storage"

const AT = new Date("2026-09-09T12:00:00.000Z")
const options = {
  allowedCodes: SYNC_RUN_FAILURE_CODES,
  defaultCode: "sync.execution_failed",
  at: AT,
} as const

// Regression proof: restore src/errors/internal.ts from HEAD; HTTP, network and
// persistence-redaction assertions fail. Restore the implementation after the check.
describe("durable failure diagnostics", () => {
  test.each([
    401, 403, 429, 503,
  ])("captures HTTP %i without connector instrumentation", (status) => {
    const provider = Object.assign(new Error("provider-secret"), { status })
    const failure = captureSixbFailure(provider, options)
    expect(failure).toMatchObject({
      code: "sync.execution_failed",
      message: `Sync execution failed. Upstream request returned HTTP ${status}.`,
      httpStatus: status,
      retryable: false,
    })
    expect(parseSixbFailure(serializeSixbFailure(failure))).toEqual(failure)
    expect(JSON.stringify(failure)).not.toContain("provider-secret")
  })

  test("keeps a specific Sixb cause without adding a second code/message pair", () => {
    const failure = captureSixbFailure(
      createSixbError("connector.authorization_required", "provider-secret"),
      options
    )
    expect(failure.message).toBe("Sync execution failed. Connector authorization is required.")
    expect(failure.code).toBe("sync.execution_failed")
    expect(failure).not.toHaveProperty("diagnostics")
  })

  test("does not guess meaning from arbitrary exception properties or aggregates", () => {
    for (const error of [
      "opaque-secret",
      new Error("opaque-secret"),
      { code: "connector.authorization_required" },
      { httpStatus: 403, failureMessage: "opaque-secret" },
      new AggregateError([{ status: 403 }]),
    ]) {
      const failure = captureSixbFailure(error, options)
      expect(failure.message).toBe("Sync execution failed.")
      expect(failure.httpStatus).toBeUndefined()
    }
  })

  test("selects one recognized cause without mixing unrelated details", () => {
    const upstream = Object.assign(new Error("private"), { statusCode: 403 })
    const local = createSixbError("dataset.not_found", "private", { cause: upstream })
    const failure = captureSixbFailure(local, options)
    expect(failure.message).toBe("Sync execution failed. Dataset not found.")
    expect(failure.httpStatus).toBeUndefined()
    expect(captureSixbFailure(new Error("wrapper", { cause: upstream }), options).httpStatus).toBe(
      403
    )
  })

  test("recognizes network codes without retaining hostnames or URLs", () => {
    const error = Object.assign(new Error("opaque-hostname"), { code: "ECONNRESET" })
    const failure = captureSixbFailure(error, options)
    expect(failure.message).toBe("Sync execution failed. The remote service reset the connection.")
    expect(failure.httpStatus).toBeUndefined()
  })

  test("bounds causal traversal and ignores throwing accessors and revoked proxies", () => {
    const cyclic = new Error("private")
    cyclic.cause = cyclic
    expect(captureSixbFailure(cyclic, options).message).toBe("Sync execution failed.")
    let calls = 0
    const hostile = Object.defineProperty(new Error(), "cause", {
      get() {
        calls++
        throw new Error()
      },
    })
    expect(() => captureSixbFailure(hostile, options)).not.toThrow()
    expect(calls).toBe(0)
    const proxy = Proxy.revocable({}, {})
    proxy.revoke()
    expect(() => captureSixbFailure(proxy.proxy, options)).not.toThrow()
    let deep: Error = Object.assign(new Error(), { status: 403 })
    for (let i = 0; i < 10; i++) deep = new Error("private", { cause: deep })
    const failure = captureSixbFailure(deep, options)
    expect(failure.truncated).toBe(true)
    expect(failure.httpStatus).toBeUndefined()
  })

  test("redacts nested credentials before capture, serialization and legacy reads", () => {
    const details = {
      runId: "run-1",
      nested: [{ password: "p4ss", api_key: "opaque-key", refreshToken: "opaque-refresh" }],
      client_secret: "opaque-client-secret",
      authorization: "Basic opaque-auth",
      cookie: "session=opaque-cookie",
      private_key: "opaque-private-key",
      connectionString: "postgres://user:password@host/db",
      note: "Bearer opaque-bearer",
      endpoint: "https://example.com/opaque-path?key=opaque-query",
      assignment: "password=opaque-assignment",
      embeddedJson: '{"password":"opaque-json-password","client_secret":"opaque-json-secret"}',
      response: { arbitrary: "opaque-body-credential" },
      headers: { "x-vendor-auth": "opaque-header-credential" },
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
    }
    const failure = toSixbFailure(
      createSixbError("sync.execution_failed", "opaque-native", { details }),
      options
    )
    expect(failure.redacted).toBe(true)
    expect(failure.details).toMatchObject({ runId: "run-1" })
    expect(JSON.stringify(failure)).not.toContain("opaque-")
    expect(JSON.stringify(failure)).not.toContain("p4ss")
    expect(details.nested[0].password).toBe("p4ss")

    // Direct provider writes and previously stored records use the same filter.
    const imported = { ...failure, details, message: "Failed: Bearer opaque-legacy" }
    const serialized = serializeSixbFailure(imported)
    expect(serialized).not.toContain("opaque-")
    expect(JSON.stringify(parseSixbFailure(JSON.stringify(imported)))).not.toContain("opaque-")
    expect(parseSixbFailure(parseSixbFailure(imported))).toEqual(parseSixbFailure(imported))
  })

  test("bounds nested context and wide arrays", () => {
    let details: { nested: unknown } = { nested: "private-depth-marker" }
    for (let i = 0; i < 20; i++) details = { nested: details }
    const deep = captureSixbFailure(new Error("private"), { ...options, details: details as never })
    expect(deep.truncated).toBe(true)
    expect(JSON.stringify(deep)).not.toContain("private-depth-marker")
    const wide = captureSixbFailure(new Error("private"), {
      ...options,
      details: { entries: Array(2000).fill(0) },
    })
    expect(wide.truncated).toBe(true)
    expect(JSON.stringify(wide).length).toBeLessThan(5000)
  })

  test("redacts known runtime secrets even inside otherwise ordinary context", () => {
    const key = "SIXB_TEST_DIAGNOSTIC_API_KEY"
    const previous = process.env[key]
    try {
      process.env[key] = "known-runtime-credential"
      const failure = captureSixbFailure(new Error("private"), {
        ...options,
        details: { note: "Failed with known-runtime-credential in an ordinary field" },
      })
      expect(failure.redacted).toBe(true)
      expect(JSON.stringify(failure)).not.toContain("known-runtime-credential")
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  test("validates upstream status without requiring it on historical records", () => {
    const failure = captureSixbFailure(new Error(), options)
    expect(parseSixbFailure(failure)).toEqual(failure)
    for (const httpStatus of ["403", 99, 600, 403.5, NaN]) {
      expect(() => parseSixbFailure({ ...failure, httpStatus })).toThrow("httpStatus")
    }
    expect(parseSixbFailure({ ...failure, httpStatus: 200 }).httpStatus).toBe(200)
    expect(() => parseSixbFailure({ ...failure, redacted: false })).toThrow("redacted")
    const invalid = Object.assign(new Error(), { status: "opaque-secret" })
    expect(captureSixbFailure(invalid, options).message).toBe("Sync execution failed.")
  })

  test("keeps redacted legacy messages within the message budget", () => {
    const failure = captureSixbFailure(new Error("private"), options)
    const parsed = parseSixbFailure({ ...failure, message: "token=a ".repeat(500) })
    expect(new TextEncoder().encode(parsed.message).length).toBeLessThanOrEqual(4096)
    expect(parsed.redacted).toBe(true)
    expect(parsed.truncated).toBe(true)
    expect(parseSixbFailure(parsed)).toEqual(parsed)
  })
})
