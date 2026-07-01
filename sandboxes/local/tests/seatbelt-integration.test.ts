import { runSandboxesContractSuite } from "@sixb/core/testing"
import { detectIsolation } from "../src/isolation/detect"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

if (process.platform === "darwin" && detectIsolation().backend === "seatbelt") {
  runSandboxesContractSuite("LocalSandbox (seatbelt)", {
    createFactory: () => new LocalSandboxFactory({ isolation: "seatbelt" }),
    capabilities: {
      networkBlocking: true,
      // Seatbelt can only deny outbound wholesale, not enforce a per-origin allow list.
      restrictedEgressEnforcement: false,
      readOnlyEnforcement: true,
      isolation: true,
    },
  })
}
