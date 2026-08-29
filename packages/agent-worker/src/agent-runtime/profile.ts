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
  | "file-tools"
  | "javascript-runtime"
  | "cli-execution"
  | "gateway-connectivity"

export type AgentRuntimeFailureReason =
  | "command-error"
  | "timed-out"
  | "nonzero-exit"
  | "invalid-output"
  | "unsupported-version"

/** Stable JSON emitted by `sixb doctor` and consumed by worker preflight. */
export interface AgentDoctorReport {
  readonly ok: true
  readonly profile: typeof AGENT_RUNTIME_PROFILE
  readonly cli: { readonly version: string }
  readonly javascript: {
    readonly name: AgentJavascriptRuntime
    readonly version: string
  }
  readonly project: { readonly id: string }
}
