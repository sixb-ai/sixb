import { AGENT_RUNTIME_PROFILE, type AgentRuntimeProfileCheck } from "./profile"

/** A provisioned sandbox does not satisfy the worker's versioned agent-runtime contract. */
export class AgentRuntimeProfileError extends Error {
  override readonly name = "AgentRuntimeProfileError"
  readonly profile = AGENT_RUNTIME_PROFILE
  readonly remediation: string

  constructor(
    readonly provider: string,
    readonly check: AgentRuntimeProfileCheck
  ) {
    const remediation = remediationFor(provider)
    super(
      `[SixbAgentWorker] Sandbox provider '${provider}' failed '${AGENT_RUNTIME_PROFILE}' check '${check}'. ${remediation}`
    )
    this.remediation = remediation
  }
}

function remediationFor(provider: string): string {
  switch (provider) {
    case "local":
      return "Install Bash, the required POSIX read utilities, and Bun 1.3+ or Node 22+ in the worker environment."
    case "smolvm":
      return "Rebuild the managed smolvm agent image with 'bun run agent:image', or configure a compatible runtime-v1 image."
    case "apple-container":
      return "Use the pinned Sixb Node image or configure an image that satisfies sixb-agent-runtime/v1."
    case "vercel":
      return "Use the explicit node24 runtime, or configure a compatible Vercel image or snapshot."
    default:
      return `Configure provider '${provider}' with an image or runtime that satisfies sixb-agent-runtime/v1.`
  }
}
