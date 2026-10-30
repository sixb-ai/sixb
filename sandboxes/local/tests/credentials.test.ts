import { runSandboxCredentialsContractSuite } from "@sixb/core/testing"
import { detectIsolation } from "../src/isolation/detect"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

runSandboxCredentialsContractSuite("LocalSandbox credentials (none)", {
  createFactory: () => new LocalSandboxFactory({ isolation: "none" }),
})

const backend = detectIsolation().backend
if (backend !== "none") {
  runSandboxCredentialsContractSuite(`LocalSandbox credentials (${backend})`, {
    createFactory: () => new LocalSandboxFactory({ isolation: backend }),
  })
}
