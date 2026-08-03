import { describe, expect, test } from "bun:test"
import {
  isSixbError,
  isSixbErrorCode,
  parseSixbFailure,
  SIXB_ERROR_CODES,
  SIXB_ERROR_RETRYABLE,
  SixbError,
  type SixbFailure,
  serializeSixbFailure,
  sixbErrorKind,
  sixbErrorNamespace,
  toSixbFailure,
} from "../src/errors"

describe("SIXB_ERROR_CODES", () => {
  test("is sorted, so a new code lands in one obvious place", () => {
    expect([...SIXB_ERROR_CODES]).toEqual([...SIXB_ERROR_CODES].sort())
  })

  test("has no duplicates", () => {
    expect(new Set(SIXB_ERROR_CODES).size).toBe(SIXB_ERROR_CODES.length)
  })

  test("is namespaced, and every namespace is lower snake case", () => {
    const malformed = SIXB_ERROR_CODES.filter((code) => !/^[a-z]+\.[a-z][a-z_]*$/.test(code))
    expect(malformed).toEqual([])
  })

  test("declares retryability for each code and nothing else", () => {
    expect(Object.keys(SIXB_ERROR_RETRYABLE).sort()).toEqual([...SIXB_ERROR_CODES].sort())
  })

  test("recognizes its own codes and rejects near misses", () => {
    expect(isSixbErrorCode("storage.conflict")).toBe(true)
    expect(isSixbErrorCode("storage.conflicts")).toBe(false)
    expect(isSixbErrorCode(undefined)).toBe(false)
  })

  test("splits into a namespace", () => {
    expect(sixbErrorNamespace("storage.conflict")).toBe("storage")
  })
})

describe("SixbError", () => {
  test("takes its retry verdict from the code", () => {
    expect(new SixbError("storage.conflict", "lost the race").retryable).toBe(true)
    expect(new SixbError("action.failed", "handler threw").retryable).toBe(false)
  })

  test("lets a call site that knows better override it", () => {
    const error = new SixbError("provider.failed", "429 with Retry-After", { retryable: true })
    expect(error.retryable).toBe(true)
  })

  test("keeps the cause, and only installs one when there is one", () => {
    const cause = new Error("ECONNREFUSED")
    expect(new SixbError("storage.unavailable", "no route", { cause }).cause).toBe(cause)
    expect("cause" in new SixbError("storage.unavailable", "no route")).toBe(false)
  })

  test("groups a code into its coarse kind, and leaves an ungrouped code alone", () => {
    expect(sixbErrorKind(new SixbError("storage.conflict", "concurrent write"))).toBe("conflict")
    expect(sixbErrorKind(new SixbError("runtime.invalid_input", "bad"))).toBe("validation")
    expect(sixbErrorKind(new SixbError("provider.unavailable", "down"))).toBe("provider")
    // `runtime.unexpected` belongs to no kind: the grouping never claims a code it cannot place.
    expect(sixbErrorKind(new SixbError("runtime.unexpected", "boom"))).toBeUndefined()
    expect(sixbErrorKind(new Error("boom"))).toBeUndefined()
  })

  test("reads the kind off a failure that crossed a bundle boundary", () => {
    // The class hierarchy this replaces could not: `instanceof` misses a second copy of the runtime.
    const foreign = Object.assign(new Error("lost the race"), { code: "storage.conflict" })
    expect(sixbErrorKind(foreign)).toBe("conflict")
  })
})

describe("isSixbError", () => {
  test("matches by instance, optionally narrowing to a code", () => {
    const error = new SixbError("storage.conflict", "lost the race")
    expect(isSixbError(error)).toBe(true)
    expect(isSixbError(error, "storage.conflict")).toBe(true)
    expect(isSixbError(error, "storage.unavailable")).toBe(false)
  })

  test("matches a failure that crossed a bundle boundary", () => {
    // What `instanceof` misses: same shape, different copy of @sixb/core.
    const foreign = Object.assign(new Error("lost the race"), { code: "storage.conflict" })
    expect(foreign instanceof SixbError).toBe(false)
    expect(isSixbError(foreign, "storage.conflict")).toBe(true)
  })

  test("rejects anything else, including a plain error and a stray code-like field", () => {
    expect(isSixbError(new Error("boom"))).toBe(false)
    expect(isSixbError({ message: "boom", code: "ENOENT" })).toBe(false)
    expect(isSixbError({ code: "storage.conflict" })).toBe(false)
    expect(isSixbError(null)).toBe(false)
    expect(isSixbError("storage.conflict")).toBe(false)
  })
})

describe("toSixbFailure", () => {
  test("records the code, the message, and the details of a Sixb error", () => {
    const failure = toSixbFailure(
      new SixbError("provider.unavailable", "connection refused", {
        details: { provider: "@sixb/queue-bullmq" },
      })
    )

    expect(failure).toEqual({
      code: "provider.unavailable",
      message: "connection refused",
      details: { provider: "@sixb/queue-bullmq" },
    })
  })

  test("files an unlabeled error under runtime.unexpected", () => {
    expect(toSixbFailure(new Error("something broke"))).toEqual({
      code: "runtime.unexpected",
      message: "something broke",
    })
  })

  test("uses the fallback code when the error carries none", () => {
    const failure = toSixbFailure(new Error("timeout"), { fallbackCode: "storage.unavailable" })
    expect(failure.code).toBe("storage.unavailable")
  })

  test("lets the error's own details win over the caller's", () => {
    const failure = toSixbFailure(
      new SixbError("action.failed", "handler threw", { details: { attempt: 3 } }),
      { details: { attempt: 1, runId: "run_1" } }
    )
    expect(failure.details).toEqual({ runId: "run_1", attempt: 3 })
  })

  test("drops details that a foreign build made non-scalar, and keeps the rest", () => {
    const foreign = Object.assign(new Error("from another bundle"), {
      code: "storage.conflict",
      details: { objectType: "Invoice", when: new Date(0), attempts: Number.NaN },
    })
    expect(toSixbFailure(foreign).details).toEqual({ objectType: "Invoice" })
  })

  test("never throws, whatever was thrown", () => {
    for (const thrown of [undefined, null, "boom", 42, { message: 7 }, Symbol("s")]) {
      const failure = toSixbFailure(thrown)
      expect(failure.code).toBe("runtime.unexpected")
      expect(typeof failure.message).toBe("string")
    }
  })
})

describe("toSixbFailure — cause", () => {
  test("renders what the error wrapped, outermost first, without repeating the message", () => {
    const driver = new Error("ECONNREFUSED")
    const storage = new SixbError("storage.unavailable", "could not reach the store", {
      cause: driver,
    })

    const failure = toSixbFailure(new Error("sync run failed", { cause: storage }))
    expect(failure.message).toBe("sync run failed")
    expect(failure.cause).toBe("could not reach the store: ECONNREFUSED")
  })

  test("is absent when nothing was wrapped", () => {
    expect(toSixbFailure(new Error("nothing under this")).cause).toBeUndefined()
    expect(toSixbFailure("just a string").cause).toBeUndefined()
  })

  test("renders a cause that is not an error", () => {
    expect(toSixbFailure(new Error("outer", { cause: "raw string" })).cause).toBe("raw string")
  })

  test("survives a cycle", () => {
    const outer = new Error("outer")
    const inner = new Error("inner", { cause: outer })
    outer.cause = inner

    expect(toSixbFailure(outer).cause).toBe("inner: outer")
  })

  test("bounds a chain that never ends", () => {
    let error = new Error("link 0")
    for (let index = 1; index < 40; index += 1) error = new Error(`link ${index}`, { cause: error })

    expect(toSixbFailure(error).cause?.split(": ").length).toBe(8)
  })

  test("does not raise a second error reading a hostile one", () => {
    const hostile = {
      get message(): string {
        throw new Error("nice try")
      },
      get cause(): unknown {
        throw new Error("nice try")
      },
    }
    expect(toSixbFailure(hostile)).toEqual({
      code: "runtime.unexpected",
      message: "[object Object]",
    })
  })
})

describe("parseSixbFailure", () => {
  const failure: SixbFailure = {
    code: "storage.unavailable",
    message: "could not reach the store",
    details: { provider: "@sixb/pg", attempt: 2, fatal: false },
    cause: "ECONNREFUSED",
  }

  test("reads back what was written, whichever dialect stored it", () => {
    const serialized = serializeSixbFailure(failure)
    expect(serialized).not.toBeNull()

    // SQLite hands back the TEXT it stored; Postgres hands back parsed JSONB.
    expect(parseSixbFailure(serialized)).toEqual(failure)
    expect(parseSixbFailure(JSON.parse(serialized as string))).toEqual(failure)
  })

  test("reads an empty column as no failure", () => {
    expect(parseSixbFailure(null)).toBeUndefined()
    expect(parseSixbFailure(undefined)).toBeUndefined()
    expect(parseSixbFailure("")).toBeUndefined()
  })

  test("reports a column it cannot read instead of dropping it", () => {
    // Silence here shows a failed run with no failure, which hides the real one.
    for (const stored of ["not json", '"a string"', '{"code":"nope","message":"x"}', "[]"]) {
      const parsed = parseSixbFailure(stored)
      expect(parsed?.code).toBe("runtime.invariant_violated")
      expect(parsed?.details?.stored).toBe(stored)
    }
  })

  test("drops what an older build wrote that no longer fits the record", () => {
    const stored = JSON.stringify({
      code: "action.failed",
      message: "handler threw",
      at: "2026-08-02T10:00:00.000Z",
      retryable: false,
      details: { actionId: "invoice.send", issues: [{ path: "amount" }] },
    })

    expect(parseSixbFailure(stored)).toEqual({
      code: "action.failed",
      message: "handler threw",
      details: { actionId: "invoice.send" },
    })
  })
})

describe("serializeSixbFailure", () => {
  test("clears the column when there is no failure", () => {
    expect(serializeSixbFailure(undefined)).toBeNull()
  })

  test("keeps the typed field an extension owns", () => {
    interface ActionRunFailure extends SixbFailure {
      readonly phase: "enqueue" | "execute"
    }
    const failure: ActionRunFailure = {
      code: "action.failed",
      message: "handler threw",
      phase: "execute",
    }

    expect(JSON.parse(serializeSixbFailure(failure) as string)).toEqual(failure)
  })
})
