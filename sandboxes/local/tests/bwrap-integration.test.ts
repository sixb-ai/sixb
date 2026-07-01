import { runSandboxesContractSuite } from "@sixb/core/testing"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

if (process.platform === "linux" && Bun.which("bwrap")) {
  runSandboxesContractSuite("LocalSandbox (bwrap)", {
    createFactory: () => new LocalSandboxFactory({ isolation: "bwrap" }),
    capabilities: {
      networkBlocking: true,
      // bwrap can only toggle a network namespace, not enforce a per-origin allow list.
      restrictedEgressEnforcement: false,
      readOnlyEnforcement: true,
      isolation: true,
    },
  })
}
