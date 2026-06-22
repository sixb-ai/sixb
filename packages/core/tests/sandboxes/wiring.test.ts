import { describe, expect, test } from "bun:test"
import { defineObjectType, prop } from "../../src/ontology"
import { Sixb } from "../../src/runtime"
import type { Sandbox, SandboxFactory } from "../../src/sandboxes"
import { createTestRuntimeDeps } from "../test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

function makeFactory(): SandboxFactory {
  return {
    create: async () =>
      ({
        id: "stub",
        provider: "stub",
        status: "running",
        workingDirectory: "/tmp/stub",
        runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
        stop: async () => {},
        destroy: async () => {},
      }) satisfies Sandbox,
  }
}

describe("Sixb sandboxes wiring", () => {
  test("sandboxes is undefined when not configured", () => {
    const sixb = new Sixb({ ontology: [Room], ...createTestRuntimeDeps() })
    expect(sixb.sandboxes).toBeUndefined()
  })

  test("sandboxes is the exact factory passed in", () => {
    const factory = makeFactory()
    const sixb = new Sixb({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      sandboxes: factory,
    })
    expect(sixb.sandboxes).toBe(factory)
  })

  test("the runtime exposes the same factory", async () => {
    const factory = makeFactory()
    const sixb = new Sixb({
      ontology: [Room],
      ...createTestRuntimeDeps(),
      sandboxes: factory,
    })

    const sandbox = await sixb.sandboxes?.create()
    expect(sandbox?.provider).toBe("stub")
  })
})
