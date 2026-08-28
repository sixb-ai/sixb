import { runSandboxesContractSuite } from "@sixb/core/testing"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"
import { runLocalAgentRuntimeConformance } from "./agent-runtime-conformance"

if (process.platform === "linux" && Bun.which("bwrap")) {
  runSandboxesContractSuite("LocalSandbox (bwrap)", {
    createFactory: () => new LocalSandboxFactory({ isolation: "bwrap" }),
    capabilities: {
      networkBlocking: true,
      readOnlyEnforcement: true,
      isolation: true,
    },
  })
  runLocalAgentRuntimeConformance(
    "LocalSandbox (bwrap)",
    () => new LocalSandboxFactory({ isolation: "bwrap" })
  )
}
