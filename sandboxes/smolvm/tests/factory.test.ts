import { expect, spyOn, test } from "bun:test"
import type { SandboxFactory } from "@sixb/core/sandboxes"
import { SmolvmSandbox } from "../src/smolvm-sandbox"
import { SmolvmSandboxFactory } from "../src/smolvm-sandbox-factory"

test("rejects persistence before provisioning", async () => {
  // Regression proof: remove the factory's persistence guard; rejection/message assertions fail.
  const provision = spyOn(SmolvmSandbox, "create").mockImplementation(async () => {
    throw new Error("Unexpected provisioning")
  })
  try {
    const factory: SandboxFactory = new SmolvmSandboxFactory({
      bin: "/nonexistent/sixb-persistence-test",
    })
    expect(factory.resume).toBeUndefined()
    await expect(factory.create({ persistence: { name: "workspace" } })).rejects.toThrow(
      "smolvm does not support persistent sandboxes"
    )
    expect(provision).not.toHaveBeenCalled()
  } finally {
    provision.mockRestore()
  }
})
