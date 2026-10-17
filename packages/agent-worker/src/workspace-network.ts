import { createSixbError } from "@sixb/core/internal/errors"
import type { SandboxNetworkPolicy, SandboxNetworkTarget } from "@sixb/core/sandboxes"

/**
 * The network of an agent run sandbox. Sixb always adds what the run needs: its API, the
 * repository the agent clones, fetches and pushes, and the origins source auth issues credentials
 * for. A restricted policy lists only what the project adds on top; `all` already covers them.
 */
export function workspaceNetwork(
  policy: SandboxNetworkPolicy | undefined,
  apiOrigin: string,
  repositoryOrigin?: string,
  credentialOrigins: readonly string[] = []
): SandboxNetworkPolicy {
  if (policy?.mode === "all") return policy

  if (policy?.mode === "none") {
    throw createSixbError(
      "agent.execution_failed",
      '[SixbAgentWorker] Sandbox network mode "none" cannot run an agent: the agent needs the Sixb API. Use { mode: "restricted", allow: [...] } with the origins the project needs; Sixb adds its own.'
    )
  }

  const required: SandboxNetworkTarget[] = [
    { name: "sixb-api", origin: apiOrigin },
    ...(repositoryOrigin ? [{ name: "workspace-repository", origin: repositoryOrigin }] : []),
    ...credentialOrigins.map((origin) => ({ name: "workspace-auth", origin })),
  ]

  // Project targets come first: an origin the project already lists keeps the project's name.
  const allow = [...(policy?.allow ?? []), ...required]

  return {
    mode: "restricted",
    allow: allow.filter(
      (target, index) => allow.findIndex((item) => item.origin === target.origin) === index
    ),
  }
}
