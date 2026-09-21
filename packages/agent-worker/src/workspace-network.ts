import { createSixbError } from "@sixb/core/internal/errors"
import type { SandboxNetworkPolicy, SandboxNetworkTarget } from "@sixb/core/sandboxes"

/** Infer minimal access only when omitted. Explicit policies are never widened. */
export function workspaceNetwork(
  policy: SandboxNetworkPolicy | undefined,
  apiOrigin: string,
  repositoryOrigin?: string,
  initializing = true
): SandboxNetworkPolicy {
  const required: SandboxNetworkTarget[] = [
    { name: "sixb-api", origin: apiOrigin },
    ...(repositoryOrigin && initializing
      ? [{ name: "workspace-repository", origin: repositoryOrigin }]
      : []),
  ]
  if (policy === undefined) {
    const allow = repositoryOrigin
      ? [...required, { name: "workspace-repository", origin: repositoryOrigin }]
      : required
    return {
      mode: "restricted",
      allow: allow.filter(
        (target, index) => allow.findIndex((item) => item.origin === target.origin) === index
      ),
    }
  }
  if (policy.mode === "all") return policy
  const denied = required.find(
    (target) =>
      policy.mode === "none" || !policy.allow.some((allowed) => allowed.origin === target.origin)
  )
  if (denied) {
    throw createSixbError(
      "agent.execution_failed",
      `[SixbAgentWorker] Sandbox network policy denies required ${denied.name} access. Update the policy before running this thread.`
    )
  }
  return policy
}
