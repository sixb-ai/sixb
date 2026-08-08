import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import * as publicCore from "../src"
import { SIXB_ERROR_DEFINITIONS } from "../src/errors/catalog"
import * as internalErrorModel from "../src/errors/internal"
import {
  createSixbError,
  isSixbError,
  parseSixbFailure,
  serializeSixbFailure,
  toSixbFailure,
} from "../src/errors/internal"
import { SYNC_RUN_FAILURE_CODES } from "../src/storage"

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

  test("serializes one detached failure snapshot and preserves its causes", () => {
    const rootCause = new TypeError("socket closed")
    const providerError = new Error("provider offline", { cause: rootCause })
    const error = createSixbError("internal.unexpected", "Commit failed", {
      cause: providerError,
      details: { operation: "commit" },
    })

    expect(toSixbFailure(error, { at: AT })).toEqual({
      code: "internal.unexpected",
      message: "Commit failed",
      retryable: false,
      at: "2026-08-05T12:00:00.000Z",
      details: { operation: "commit" },
      causeChain: [
        { name: "Error", message: "provider offline" },
        { name: "TypeError", message: "socket closed" },
      ],
    })
  })

  test("bridges arbitrary thrown values without losing safe context", () => {
    const crossRealmLike = {
      name: "ProviderError",
      message: "offline",
      cause: "connection refused",
    }

    expect(
      toSixbFailure(crossRealmLike, {
        at: AT,
        fallbackCode: "internal.unexpected",
        fallbackDetails: { provider: "example" },
      })
    ).toEqual({
      code: "internal.unexpected",
      message: "offline",
      retryable: false,
      at: "2026-08-05T12:00:00.000Z",
      details: { provider: "example" },
      causeChain: [{ name: "Error", message: "connection refused" }],
    })
  })

  test("round-trips and validates failure records at storage boundaries", () => {
    const failure = toSixbFailure(new Error("provider offline"), {
      at: AT,
      fallbackDetails: { provider: "example" },
    })
    const serialized = serializeSixbFailure(failure)

    expect(parseSixbFailure(serialized)).toEqual(failure)
    expect(parseSixbFailure(JSON.parse(serialized))).toEqual(failure)
    expect(() => parseSixbFailure({ ...failure, code: "future.unknown" })).toThrow(
      "code is not a known Sixb error code"
    )
    expect(() => parseSixbFailure({ ...failure, retryable: true })).toThrow(
      "retryable does not match the error code policy"
    )
    expect(() => parseSixbFailure({ ...failure, at: "2026-08-05" })).toThrow(
      "at is not a canonical ISO-8601 timestamp"
    )
  })

  test("constrains a failure to the codes declared by its boundary", () => {
    const datasetError = createSixbError("dataset.not_found", "Dataset is missing")

    expect(
      toSixbFailure(datasetError, {
        allowedCodes: SYNC_RUN_FAILURE_CODES,
        fallbackCode: "internal.unexpected",
        fallbackDetails: { syncId: "sync-orders" },
        at: AT,
      })
    ).toMatchObject({
      code: "internal.unexpected",
      details: { syncId: "sync-orders" },
    })

    const datasetFailure = toSixbFailure(datasetError, { at: AT })
    expect(parseSixbFailure(datasetFailure)).toEqual(datasetFailure)
    expect(() => parseSixbFailure(datasetFailure, SYNC_RUN_FAILURE_CODES)).toThrow(
      "code is not allowed by this failure contract"
    )
  })

  test("bounds hostile cause graphs and rejects non-serializable details", () => {
    const cyclic = new Error("cyclic")
    Object.defineProperty(cyclic, "cause", { value: cyclic })
    expect(toSixbFailure(cyclic, { at: AT }).causeChain).toBeUndefined()

    expect(() =>
      createSixbError("internal.unexpected", "Invalid details", {
        details: { invalid: undefined } as never,
      })
    ).toThrow("Sixb error details.invalid is undefined")

    expect(() => toSixbFailure(new Error("boom"), { at: new Date(Number.NaN) })).toThrow(
      "[Sixb] Failure timestamp must be a valid Date."
    )
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
