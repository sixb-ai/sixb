import type { SandboxNetworkPolicy } from "@sixb/core"

/**
 * Translate a provider-agnostic network policy into smolvm CLI flags.
 *
 * - "none":       no flags; the VM gets no network at all.
 * - "restricted": "--net" plus one "--allow-host <host>" per allowed origin.
 * - "all":        "--net" with no allow list (discouraged in production).
 *
 * This is strictly stronger than the local backend's all-or-nothing network
 * namespace toggle: smolvm enforces the per-origin allow list the Sandbox
 * contract always intended.
 */
export function buildNetworkFlags(policy: SandboxNetworkPolicy): string[] {
  if (policy.mode === "none") {
    return []
  }
  if (policy.mode === "all") {
    return ["--net"]
  }
  const flags = ["--net"]
  for (const target of policy.allow) {
    flags.push("--allow-host", hostFromOrigin(target.origin))
  }
  return flags
}

/**
 * Extract the bare hostname from an origin. smolvm allow-host examples use
 * DNS hostnames without a port, so we allow at the host level and let any port
 * on that host through; for the sixb gateway (our own server) that is fine.
 */
function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

/**
 * Docker Hub hosts an in-guest pull touches: the registry index/auth/endpoint
 * plus the CloudFront CDN that serves layer/config blobs (verified against a
 * real `alpine` pull). Allowlisting these lets an image machine pull under
 * restricted egress without opening the whole internet.
 */
export const DOCKER_HUB_REGISTRY_HOSTS = [
  "index.docker.io",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudfront.docker.com",
] as const

/**
 * Augment a policy so it also permits egress to the given registry hosts — the
 * minimum needed for an image machine to pull at start while staying scoped.
 *
 * Only meaningful for "restricted": "all" already permits everything, and
 * "none" stays offline (a "none" policy with an image cannot pull — use
 * "restricted" or a bare machine).
 */
export function withRegistryEgress(
  policy: SandboxNetworkPolicy,
  hosts: readonly string[]
): SandboxNetworkPolicy {
  if (policy.mode !== "restricted" || hosts.length === 0) {
    return policy
  }
  const extra = hosts.map((host) => ({ name: `registry:${host}`, origin: `https://${host}` }))
  return { mode: "restricted", allow: [...policy.allow, ...extra] }
}
