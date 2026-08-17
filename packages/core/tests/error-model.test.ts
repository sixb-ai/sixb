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
  parseSixbFailure,
  SIXB_FAILURE_MAX_SERIALIZED_BYTES,
  serializeSixbFailure,
  summarizeErrorMessage,
  toSixbFailure,
} from "../src/errors/internal"
import { ACTION_RUN_FAILURE_CODES, SYNC_RUN_FAILURE_CODES } from "../src/storage"
import {
  parseActionRunFailure,
  serializeActionRunFailure,
} from "../src/storage/action-runs/failure"

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

  test("round-trips and validates failure records at storage boundaries", () => {
    const failure = captureSixbFailure(new Error("provider offline"), {
      allowedCodes: SYNC_RUN_FAILURE_CODES,
      defaultCode: "internal.unexpected",
      at: AT,
      details: { syncId: "sync-1", runId: "run-1" },
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
    const datasetError = createSixbError("dataset.not_found", "Dataset is missing", {
      details: { datasetId: "foreign" },
    })

    expect(() =>
      toSixbFailure(datasetError, {
        allowedCodes: SYNC_RUN_FAILURE_CODES,
        at: AT,
      })
    ).toThrow("Error code 'dataset.not_found' is not allowed by this failure contract")

    const scopedFailure = captureSixbFailure(datasetError, {
      allowedCodes: SYNC_RUN_FAILURE_CODES,
      defaultCode: "internal.unexpected",
      details: { syncId: "sync-1", runId: "run-1" },
      at: AT,
    })
    expect(scopedFailure.code).toBe("internal.unexpected")
    expect(scopedFailure.details).toEqual({ syncId: "sync-1", runId: "run-1" })

    const cancellation = createSixbError("runtime.cancelled", "Sync cancelled", {
      details: { syncId: "sync-1", runId: "run-1", reason: "shutdown" },
    })
    expect(
      captureSixbFailure(cancellation, {
        allowedCodes: SYNC_RUN_FAILURE_CODES,
        defaultCode: "internal.unexpected",
        details: { syncId: "fallback", runId: "fallback" },
        at: AT,
      }).details
    ).toEqual({ syncId: "sync-1", runId: "run-1", reason: "shutdown" })

    const datasetFailure = toSixbFailure(datasetError, { at: AT })
    expect(parseSixbFailure(datasetFailure)).toEqual(datasetFailure)
    expect(() => parseSixbFailure(datasetFailure, SYNC_RUN_FAILURE_CODES)).toThrow(
      "code is not allowed by this failure contract"
    )
  })

  test("round-trips the typed Action phase without weakening the base failure codec", () => {
    const failure = parseActionRunFailure(
      toSixbFailure(
        createSixbError("internal.unexpected", "Writeback failed", {
          cause: new Error("writeback failed"),
          details: { actionId: "send-quote", runId: "act_1", phase: "writeback" },
        }),
        {
          allowedCodes: ACTION_RUN_FAILURE_CODES,
          at: AT,
        }
      ),
      "writeback"
    )
    const serialized = serializeActionRunFailure(failure)

    expect(parseActionRunFailure(serialized)).toEqual(failure)
    expect(() =>
      parseActionRunFailure({ ...failure, details: { ...failure.details, phase: "future" } })
    ).toThrow("Action details must contain actionId, runId, and a known phase")
    expect(() => parseActionRunFailure({ ...failure, code: "dataset.not_found" })).toThrow(
      "code is not allowed by this failure contract"
    )
    expect(() => parseActionRunFailure(failure, "effects")).toThrow(
      "Stored Action effects failure has phase 'writeback'"
    )
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
