import { runSandboxesContractSuite } from "@sixb/core/testing"
import { detectIsolation } from "../src/isolation/detect"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"
import { runLocalAgentRuntimeConformance } from "./agent-runtime-conformance"

if (process.platform === "darwin" && detectIsolation().backend === "seatbelt") {
  runSandboxesContractSuite("LocalSandbox (seatbelt)", {
    createFactory: () => new LocalSandboxFactory({ isolation: "seatbelt" }),
    capabilities: {
      networkBlocking: true,
      readOnlyEnforcement: true,
      isolation: true,
    },
  })
  runLocalAgentRuntimeConformance(
    "LocalSandbox (seatbelt)",
    () => new LocalSandboxFactory({ isolation: "seatbelt" })
  )
}
