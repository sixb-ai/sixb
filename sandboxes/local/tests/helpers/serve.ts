import type { SandboxesContractSuiteOptions } from "@sixb/core/testing"

/** A free port on this machine, and Bun serving `ok` on it. */
export const serveOk: NonNullable<SandboxesContractSuiteOptions["serve"]> = {
  port: () => {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    const { port } = listener
    listener.stop(true)
    return port
  },
  command: (port) => [
    process.execPath,
    "-e",
    `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("ok") })`,
  ],
}
