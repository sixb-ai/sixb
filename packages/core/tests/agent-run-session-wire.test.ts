import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { lostConnectionCode, modelCallInterrupted } from "../src/agents/model-call-retry"
import {
  decodeWireError,
  encodeModelCallError,
  encodeWireError,
  wireErrorStatus,
} from "../src/agents/run-session-wire"
import { ModelProviderError } from "../src/models"

// What postgres.js throws when the database refuses its connection.
const storageRefused = () =>
  Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })

afterEach(() => {
  jest.restoreAllMocks()
})

describe("a run session operation's failure", () => {
  // Reproduce: read lost connections in encodeWireError again; a database outage then reaches the
  // runner as a lost model provider, and the server logs nothing.
  test("that lost its storage connection stays on the server, logged", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {})
    const error = storageRefused()

    const wire = encodeWireError(error)

    expect(wire).toEqual({
      kind: "Error",
      message: "[Sixb] The run session operation failed on the server.",
    })
    expect(wireErrorStatus(wire)).toBe(500)
    expect(logged).toHaveBeenCalledWith("[Sixb] A run session operation failed.", error)
  })
})

describe("a model call's failure", () => {
  test("that lost its connection crosses as one, for the runner's loop to ask again", () => {
    const wire = encodeModelCallError(storageRefused())

    expect(wire).toMatchObject({ kind: "ModelConnectionLost", code: "ECONNREFUSED" })
    expect(wireErrorStatus(wire)).toBe(502)
    expect(lostConnectionCode(decodeWireError(wire))).toBe("ECONNREFUSED")
  })

  test("that its provider interrupted crosses as an interrupted provider error", () => {
    const overloaded = new ModelProviderError("[test] Overloaded.", "test", "model", {
      code: "overloaded_error",
      reason: "interrupted",
    })

    const decoded = decodeWireError(encodeModelCallError(overloaded))

    expect(decoded).toBeInstanceOf(ModelProviderError)
    expect(decoded).toMatchObject({
      message: "[test] Overloaded.",
      providerId: "test",
      modelId: "model",
      code: "overloaded_error",
      reason: "interrupted",
    })
    expect(modelCallInterrupted(decoded)).toBe(true)
  })

  test("of any other kind crosses as any operation's", () => {
    const logged = spyOn(console, "error").mockImplementation(() => {})
    const refused = new ModelProviderError("[test] Bad request.", "test", "model", { status: 400 })

    expect(encodeModelCallError(refused)).toEqual(encodeWireError(refused))
    expect(logged).toHaveBeenCalledTimes(2)
  })
})
