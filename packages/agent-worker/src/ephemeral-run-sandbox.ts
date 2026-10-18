import type { RunSandbox } from "./run-sandbox"
import type { AgentExecutionContext } from "./types"

interface EphemeralRunSandboxInput {
  /** The run's context: its project factory creates the sandbox, which reaches its Sixb API. */
  readonly context: Pick<AgentExecutionContext, "sandboxes" | "apiBaseUrl">
}

/**
 * A sandbox created for one run and destroyed when the run releases it.
 *
 * It is blank: no source or setup, and only the Sixb API on the network. The prompt describes
 * nothing about it, so it boots concurrently with the first model call.
 */
export function ephemeralRunSandbox(input: EphemeralRunSandboxInput): RunSandbox {
  const { sandboxes, apiBaseUrl } = input.context
  const apiOrigin = new URL(apiBaseUrl).origin

  return {
    waitBeforeModel: false,
    acquire: async () => ({
      sandbox: await sandboxes.create({
        environment: {},
        network: { mode: "restricted", allow: [{ name: "sixb-api", origin: apiOrigin }] },
      }),
    }),
    release: (acquired) => acquired.sandbox.destroy(),
  }
}
