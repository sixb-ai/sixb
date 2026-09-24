import { expect, test } from "bun:test"
import { LocalSandboxFactory } from "../src"

test.each([
  undefined,
  {},
  { setup: ["touch override-marker"] },
])("applies exactly the selected environment: %j", async (environment) => {
  // Regression proof: initialize only options.environment; the default-marker case fails.
  const factory = new LocalSandboxFactory({ isolation: "none", setup: ["touch default-marker"] })
  const sandbox = await factory.create({ environment })
  try {
    expect((await sandbox.runCommand("test", ["-f", "default-marker"])).exitCode).toBe(
      environment === undefined ? 0 : 1
    )
    expect((await sandbox.runCommand("test", ["-f", "override-marker"])).exitCode).toBe(
      environment?.setup ? 0 : 1
    )
  } finally {
    await sandbox.destroy()
  }
})

test("rejects unresolved recipes before even checking the requested working directory", async () => {
  const factory = new LocalSandboxFactory({
    isolation: "none",
    resolve: () => {
      throw new Error("not called")
    },
  })
  await expect(
    factory.create({ workingDirectory: "/nonexistent/sixb-environment-test" })
  ).rejects.toThrow("execution-resolved")
})
