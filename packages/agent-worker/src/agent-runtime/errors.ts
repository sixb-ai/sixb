import {
  AGENT_RUNTIME_PROFILE,
  type AgentRuntimeFailureReason,
  type AgentRuntimeProfileCheck,
} from "./profile"

/** A provisioned sandbox does not satisfy the worker's versioned agent-runtime contract. */
export class AgentRuntimeProfileError extends Error {
  override readonly name = "AgentRuntimeProfileError"
  readonly profile = AGENT_RUNTIME_PROFILE
  readonly remediation: string

  constructor(
    readonly provider: string,
    readonly check: AgentRuntimeProfileCheck,
    readonly reason: AgentRuntimeFailureReason,
    readonly exitCode?: number
  ) {
    const remediation = remediationFor(check)
    const failure = exitCode === undefined ? reason : `${reason} (exit ${exitCode})`
    super(
      `[SixbAgentWorker] Sandbox provider '${provider}' failed '${AGENT_RUNTIME_PROFILE}' check '${check}': ${failure}. ${remediation}`
    )
    this.remediation = remediation
  }
}

function remediationFor(check: AgentRuntimeProfileCheck): string {
  switch (check) {
    case "bash":
      return "Provide Bash in the configured sandbox host or image."
    case "environment-bootstrap":
      return "Ensure sandbox commands preserve the worker-provided environment and load BASH_ENV."
    case "path-bootstrap":
      return "Ensure BASH_ENV can prepend the worker-installed Sixb CLI directory to PATH."
    case "cli-installation":
      return "Ensure sandbox file materialization preserves the Sixb CLI bytes and executable mode."
    case "file-tools":
      return "Provide compatible realpath, tail, head, base64, find, wc, and tr utilities in the sandbox."
    case "javascript-runtime":
      return "Provide Bun 1.3+ or Node 22+ in the configured sandbox host or image."
    case "cli-execution":
      return "Ensure the worker-installed Sixb CLI artifact can execute without modifying it."
    case "gateway-connectivity":
      return "Ensure the run-scoped Sixb API gateway is reachable from the sandbox and identifies the current project."
  }
}
