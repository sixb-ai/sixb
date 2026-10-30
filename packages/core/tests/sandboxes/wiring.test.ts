import { expect, test } from "bun:test"
import { defineObjectType, prop } from "../../src/ontology"
import { SixbHost } from "../../src/runtime"
import type { SandboxFactory } from "../../src/sandboxes"
import { createTestRuntimeDeps } from "../test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

test("SixbHost exposes the configured sandbox factory, or none", () => {
  const factory: SandboxFactory = {
    supportsRequestCredentials: true,
    create: async () => {
      throw new Error("unused")
    },
  }

  expect(new SixbHost({ ontology: [Room], ...createTestRuntimeDeps() }).sandboxes).toBeUndefined()
  expect(
    new SixbHost({ ontology: [Room], ...createTestRuntimeDeps(), sandboxes: factory }).sandboxes
  ).toBe(factory)
})
