import { runSandboxesContractSuite } from "@sixb/core/testing"
import { detectIsolation } from "../src/isolation/detect"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

if (process.platform === "darwin" && detectIsolation().backend === "seatbelt") {
  runSandboxesContractSuite("LocalSandbox (seatbelt)", {
    createFactory: () => new LocalSandboxFactory({ isolation: "seatbelt" }),
    capabilities: {
      networkBlocking: true,
      readOnlyEnforcement: true,
      isolation: true,
    },
    // The timer starts after the spawn, so any bound below `sleep`'s runtime proves the kill.
    shortTimeoutMs: 50,
  })
}
