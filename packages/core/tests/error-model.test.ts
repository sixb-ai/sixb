import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import * as publicCore from "../src"
import { SIXB_ERROR_DEFINITIONS } from "../src/errors/catalog"
import * as internalErrorModel from "../src/errors/internal"
import {
  captureSixbFailure,
  createSixbError,
  isSixbError,
  SIXB_FAILURE_MAX_SERIALIZED_BYTES,
  summarizeErrorMessage,
  toSixbFailure,
} from "../src/errors/internal"

const AT = new Date("2026-08-05T12:00:00.000Z")

describe("Sixb error model", () => {
  test("keeps the error class private while exposing serializable contracts", () => {
    expect(publicCore).not.toHaveProperty("SixbError")
    expect(internalErrorModel).not.toHaveProperty("SixbError")
  })

  test("creates a coded internal error from catalog policy", () => {
    const cause = new Error("provider offline")
    const details = { operation: "commit", nested: { attempt: 2 } }
    const error = createSixbError("internal.unexpected", "Commit failed", {
      cause,
      details,
    })

    details.nested.attempt = 3

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("SixbError")
    expect(error.code).toBe("internal.unexpected")
    expect(error.retryable).toBe(false)
    expect(error.cause).toBe(cause)
    expect(error.details).toEqual({ operation: "commit", nested: { attempt: 2 } })
    expect(isSixbError(error)).toBe(true)
    expect(isSixbError(new Error("ordinary"))).toBe(false)
  })

  test("serializes a bounded public failure without exposing native causes", () => {
    const rootCause = new TypeError("socket closed")
    const providerError = new Error("provider offline", { cause: rootCause })
    const error = createSixbError("internal.unexpected", "Commit failed", {
      cause: providerError,
      details: { operation: "commit" },
    })

    expect(toSixbFailure(error, { at: AT })).toEqual({
      code: "internal.unexpected",
      message: "An unexpected internal error occurred.",
      retryable: false,
      at: "2026-08-05T12:00:00.000Z",
      details: { operation: "commit" },
    })
    expect(error.cause).toBe(providerError)
  })

  test("captures arbitrary thrown values without exposing diagnostic data", () => {
    const crossRealmLike = {
      name: "ProviderError",
      message: "offline",
      cause: "connection refused",
    }

    expect(
      captureSixbFailure(crossRealmLike, {
        allowedCodes: ["internal.unexpected"],
        defaultCode: "internal.unexpected",
        at: AT,
        details: { provider: "example" },
      })
    ).toEqual({
      code: "internal.unexpected",
      message: "An unexpected internal error occurred.",
      retryable: false,
      at: "2026-08-05T12:00:00.000Z",
      details: { provider: "example" },
    })
    expect(summarizeErrorMessage(crossRealmLike, "fallback")).toBe("offline")
    expect(summarizeErrorMessage({ reason: "offline" }, "fallback")).toBe("fallback")

    expect(() =>
      // @ts-expect-error Unknown values must go through captureSixbFailure.
      toSixbFailure(new Error("uncoded"))
    ).toThrow("A durable failure can only be created from a coded Sixb error")
  })

  test("bounds durable records and rejects non-serializable details", () => {
    expect(() =>
      createSixbError("internal.unexpected", "Invalid details", {
        details: { invalid: undefined } as never,
      })
    ).toThrow("Sixb error details.invalid is undefined")

    expect(() =>
      toSixbFailure(createSixbError("internal.unexpected", "boom"), {
        at: new Date(Number.NaN),
      })
    ).toThrow("[Sixb] Failure timestamp must be a valid Date.")

    const oversized = toSixbFailure(
      createSixbError("internal.unexpected", "Provider failed", {
        cause: new Error("provider secret"),
        details: { payload: "x".repeat(SIXB_FAILURE_MAX_SERIALIZED_BYTES) },
      }),
      { at: AT }
    )
    expect(oversized).toEqual({
      code: "internal.unexpected",
      message: "An unexpected internal error occurred.",
      retryable: false,
      at: AT.toISOString(),
      truncated: true,
    })
    expect(JSON.stringify(oversized)).not.toContain("provider secret")
  })

  test("documents every catalog code exactly once", async () => {
    const documentation = await readFile(
      resolve(import.meta.dir, "../../../docs/runtime/error-codes.md"),
      "utf8"
    )
    const documentedCodes = [...documentation.matchAll(/^\| `([^`]+)` \|/gm)].map(
      ([, code]) => code
    )

    expect(documentedCodes.sort()).toEqual(Object.keys(SIXB_ERROR_DEFINITIONS).sort())
  })
})
