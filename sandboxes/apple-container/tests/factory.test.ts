import { expect, spyOn, test } from "bun:test"
import type { SandboxFactory } from "@sixb/core/sandboxes"
import { AppleContainerSandbox } from "../src/apple-container-sandbox"
import { AppleContainerSandboxFactory } from "../src/apple-container-sandbox-factory"

test("rejects persistence before provisioning", async () => {
  // Regression proof: remove the factory's persistence guard; rejection/message assertions fail.
  const provision = spyOn(AppleContainerSandbox, "create").mockImplementation(async () => {
    throw new Error("Unexpected provisioning")
  })
  try {
    const factory: SandboxFactory = new AppleContainerSandboxFactory({
      bin: "/nonexistent/sixb-persistence-test",
    })
    expect(factory.resume).toBeUndefined()
    await expect(factory.create({ persistence: { name: "workspace" } })).rejects.toThrow(
      "apple-container does not support persistent sandboxes"
    )
    expect(provision).not.toHaveBeenCalled()
  } finally {
    provision.mockRestore()
  }
})
