import { expect, spyOn, test } from "bun:test"
import type { SandboxFactory } from "@sixb/core/sandboxes"
import { LocalSandbox } from "../src/local-sandbox"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

test("rejects persistence before provisioning", async () => {
  // Regression proof: remove the factory's persistence guard; rejection/message assertions fail.
  const provision = spyOn(LocalSandbox, "create").mockImplementation(async () => {
    throw new Error("Unexpected provisioning")
  })
  try {
    const factory: SandboxFactory = new LocalSandboxFactory({})
    expect(factory.resume).toBeUndefined()
    await expect(factory.create({ persistence: { name: "workspace" } })).rejects.toThrow(
      "local does not support persistent sandboxes"
    )
    expect(provision).not.toHaveBeenCalled()
  } finally {
    provision.mockRestore()
  }
})
