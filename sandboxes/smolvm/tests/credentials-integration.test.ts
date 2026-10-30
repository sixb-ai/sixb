import { networkInterfaces } from "node:os"
import { GUEST_CREDENTIAL_PATHS } from "@sixb/core/sandboxes"
import { runSandboxCredentialsContractSuite } from "@sixb/core/testing"
import { probeSmolvm } from "../src/preflight"
import { SmolvmSandboxFactory } from "../src/smolvm-sandbox-factory"

/**
 * Request credentials in a real VM: a root forwarder in the guest holds them, and the commands,
 * which run unprivileged, reach the suite's server on this host without being able to read them.
 * The forwarder needs Bun or Node, so this needs an image with one: set
 * SIXB_SMOLVM_CREDENTIALS_IMAGE, for example to oven/bun:1.4.4. The guest reaches this host at its
 * LAN address, as it reaches a development API.
 */
const image = process.env.SIXB_SMOLVM_CREDENTIALS_IMAGE
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address

if (image && lanAddress && probeSmolvm("smolvm").ok) {
  runSandboxCredentialsContractSuite(`SmolvmSandbox credentials (${image})`, {
    createFactory: () => new SmolvmSandboxFactory({ image, timeout: 120_000 }),
    originFor: (port) => `http://${lanAddress}:${port}`,
    privatePaths: [GUEST_CREDENTIAL_PATHS.state],
  })
}
