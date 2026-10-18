import { expect, test } from "bun:test"
import {
  SandboxError,
  SandboxIsolationUnavailableError,
  SandboxNotRunningError,
  SandboxTimeoutError,
} from "../../src/sandboxes"

test.each([
  [SandboxError, "SandboxError"],
  [SandboxNotRunningError, "SandboxNotRunningError"],
  [SandboxTimeoutError, "SandboxTimeoutError"],
  [SandboxIsolationUnavailableError, "SandboxIsolationUnavailableError"],
])("each sandbox error extends SandboxError and Error with its own name: %p", (ErrorClass, name) => {
  const error = new ErrorClass("stopped")

  expect(error).toBeInstanceOf(SandboxError)
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe(name)
  expect(error.message).toBe("stopped")
})
