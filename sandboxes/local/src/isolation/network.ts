import type { SandboxNetworkPolicy } from "@sixb/core"

/**
 * Whether a policy permits outbound network on a local backend. Local isolation is binary today:
 * it can only toggle a network namespace (bwrap `--unshare-net`) or an outbound deny (seatbelt), so
 * anything other than "none" resolves to full host network — the per-origin allow list is not
 * enforceable here.
 */
export function allowsOutboundNetwork(policy: SandboxNetworkPolicy): boolean {
  return policy.mode !== "none"
}

let warnedRestrictedDowngrade = false

/**
 * A "restricted" policy asks for a specific allow list, but local backends cannot enforce one and
 * fall back to full host network. Warn once so this downgrade is loud and never reads silently as
 * "all"; use the smolvm provider when egress must actually be restricted.
 */
export function warnIfRestrictedDowngraded(policy: SandboxNetworkPolicy): void {
  if (warnedRestrictedDowngrade || policy.mode !== "restricted") {
    return
  }
  warnedRestrictedDowngrade = true
  console.warn(
    "[Sandbox] local sandboxes cannot enforce restricted network egress; downgrading to host " +
      "network. The allow list is NOT applied. Use the smolvm provider for enforced egress."
  )
}
