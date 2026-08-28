export const AGENT_RUNTIME_PROFILE = "sixb-agent-runtime/v1" as const

export const AGENT_RUNTIME_MINIMUM_VERSIONS = {
  bun: { major: 1, minor: 3 },
  node: { major: 22, minor: 0 },
} as const

export type AgentJavascriptRuntime = keyof typeof AGENT_RUNTIME_MINIMUM_VERSIONS

export type AgentRuntimeProfileCheck =
  | "bash"
  | "environment-bootstrap"
  | "path-bootstrap"
  | "cli-installation"
  | "read-tool"
  | "javascript-runtime"
  | "cli-execution"
  | "gateway-connectivity"

export interface AgentRuntimeInfo {
  readonly profile: typeof AGENT_RUNTIME_PROFILE
  readonly provider: string
  readonly javascript: {
    readonly name: AgentJavascriptRuntime
    readonly version: string
  }
  readonly cliVersion: string
}
