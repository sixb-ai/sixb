import { describe, expect, test } from "bun:test"
import { errorMessage, errorRemediation, SixbCliError } from "../src/lib/errors"

describe("errorMessage", () => {
  test("narrows a thrown non-Error instead of losing it", () => {
    // Eleven catch blocks each wrote this narrowing by hand. A `throw "boom"` from a
    // dependency has to reach the terminal as something, not as `[object Object]`.
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("boom")).toBe("boom")
    expect(errorMessage(undefined)).toBe("undefined")
  })
})

describe("errorRemediation", () => {
  test("reads the remediation off the error itself", () => {
    const error = new SixbCliError("cannot start", { remediation: "run `sixb db migrate`" })

    expect(errorRemediation(error)).toBe("run `sixb db migrate`")
  })

  test("survives being wrapped, which is how the CLI adds context", () => {
    // `migrateStorageForRole` wraps a driver's lock error to explain the case it
    // represents. A remedy that only lived until the first wrap would be lost exactly
    // where an operator needs it.
    const wrapped = new Error("outer", {
      cause: new SixbCliError("inner", { remediation: "pass --no-migrate" }),
    })

    expect(errorRemediation(wrapped)).toBe("pass --no-migrate")
  })

  test("returns nothing for an ordinary error", () => {
    expect(errorRemediation(new Error("boom"))).toBeUndefined()
    expect(errorRemediation("boom")).toBeUndefined()
    expect(errorRemediation(new SixbCliError("boom"))).toBeUndefined()
  })

  test("terminates on a cause that points at itself", () => {
    // A cycle is not something the CLI creates, but walking a chain from an arbitrary
    // thrown value means it can arrive. Hanging here would hang the error path.
    const cyclic = new Error("loop")
    Object.defineProperty(cyclic, "cause", { value: cyclic })

    expect(errorRemediation(cyclic)).toBeUndefined()
  })
})
