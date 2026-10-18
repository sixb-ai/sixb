import { runSandboxesContractSuite } from "@sixb/core/testing"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

if (process.platform === "linux" && Bun.which("bwrap")) {
  runSandboxesContractSuite("LocalSandbox (bwrap)", {
    createFactory: () => new LocalSandboxFactory({ isolation: "bwrap" }),
    capabilities: {
      networkBlocking: true,
      readOnlyEnforcement: true,
      isolation: true,
    },
    // The timer starts after the spawn, so any bound below `sleep`'s runtime proves the kill.
    shortTimeoutMs: 50,
  })
}
