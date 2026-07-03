import { expect, test } from "bun:test"
import { AppleContainerSandbox } from "../src/apple-container-sandbox"
import { DEFAULT_APPLE_CONTAINER_IMAGE } from "../src/apple-container-sandbox-factory"
import { probeAppleContainer } from "../src/preflight"

const runIntegration = process.env.SIXB_APPLE_CONTAINER_INTEGRATION === "1" ? test : test.skip

runIntegration(
  "runs a command through a real Apple Container sandbox",
  async () => {
    const probe = probeAppleContainer(process.env.SIXB_APPLE_CONTAINER_BIN ?? "container")
    expect(probe.ok).toBe(true)

    const sandbox = await AppleContainerSandbox.create({
      cli: {
        bin: process.env.SIXB_APPLE_CONTAINER_BIN ?? "container",
        image: process.env.SIXB_APPLE_CONTAINER_IMAGE ?? DEFAULT_APPLE_CONTAINER_IMAGE,
        mounts: [],
        ports: [],
        dns: [],
        createArgs: [],
      },
      network: { mode: "all" },
    })
    try {
      const result = await sandbox.runCommand("bash", ["-lc", "printf sixb"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("sixb")
    } finally {
      await sandbox.destroy()
    }
  },
  180_000
)
