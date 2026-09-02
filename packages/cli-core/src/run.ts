import { ApiClient } from "./api-client"
import { dispatch } from "./commands"

export interface SandboxInstanceCliMode {
  readonly kind: "sandbox"
  readonly baseUrl: string
  readonly runContextPath: string
}

export interface LocalInstanceCliMode {
  readonly kind: "local"
  readonly baseUrl: string
  readonly token?: string
  readonly profile?: string
}

export type InstanceCliMode = SandboxInstanceCliMode | LocalInstanceCliMode

export interface RunInstanceCliInput {
  readonly args: readonly string[]
  readonly mode: InstanceCliMode
}

export async function runInstanceCli(input: RunInstanceCliInput): Promise<void> {
  const [command, ...args] = input.args
  await dispatch(createInstanceApiClient(input.mode), command ?? "", args)
}

export function createInstanceApiClient(mode: InstanceCliMode): ApiClient {
  return new ApiClient({
    baseUrl: mode.baseUrl,
    ...(mode.kind === "local" && mode.token ? { authorization: `Bearer ${mode.token}` } : {}),
    missingBaseUrlMessage:
      mode.kind === "sandbox"
        ? "SIXB_API_BASE_URL is not set."
        : "The selected Sixb profile has no API URL.",
    unavailableMessage:
      mode.kind === "sandbox"
        ? "The Sixb API gateway could not be reached."
        : "The Sixb API could not be reached.",
    unavailableHint:
      mode.kind === "sandbox"
        ? "Run 'sixb doctor' to verify the sandbox runtime and gateway."
        : "Run 'sixb status' to verify the current profile.",
  })
}
