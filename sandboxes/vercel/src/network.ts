import { isIP } from "node:net"
import type { SandboxNetworkPolicy } from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import type { NetworkPolicy } from "@vercel/sandbox"

/**
 * Translate Sixb's provider-neutral egress policy into Vercel Sandbox's firewall policy.
 *
 * Vercel domain allow rules are TLS/SNI-based. HTTPS origins map to domain rules; plain HTTP can
 * only be constrained by IP/CIDR, so hostname-only HTTP origins are rejected with an actionable
 * error instead of silently widening egress.
 */
export function toVercelNetworkPolicy(policy: SandboxNetworkPolicy | undefined): NetworkPolicy {
  if (policy === undefined || policy.mode === "none") {
    return "deny-all"
  }
  if (policy.mode === "all") {
    return "allow-all"
  }
  if (policy.allow.length === 0) {
    return "deny-all"
  }

  const domains = new Set<string>()
  const cidrs = new Set<string>()

  for (const target of policy.allow) {
    const origin = parseNetworkTarget(target.origin)
    if (isLoopbackHost(origin.host)) {
      throw new SixbError(
        "sandbox.failed",
        `[Sandbox] Vercel Sandbox runs remotely and cannot reach restricted target '${target.name}' at ${target.origin}. Use a public HTTPS gateway origin instead of localhost/loopback.`
      )
    }

    const cidr = cidrForHost(origin.host)
    if (cidr) {
      cidrs.add(cidr)
      continue
    }

    if (origin.protocol === "http:") {
      throw new SixbError(
        "sandbox.failed",
        `[Sandbox] Vercel Sandbox cannot enforce a hostname allow-list for plain HTTP target '${target.name}' (${target.origin}); Vercel's domain firewall is TLS/SNI-based. Use HTTPS, or point the target at an IP/CIDR-reachable origin.`
      )
    }

    domains.add(origin.host)
  }

  if (domains.size === 0 && cidrs.size === 0) {
    return "deny-all"
  }

  return {
    ...(domains.size > 0 ? { allow: [...domains] } : {}),
    ...(cidrs.size > 0 ? { subnets: { allow: [...cidrs] } } : {}),
  }
}

interface ParsedNetworkTarget {
  readonly protocol: string | undefined
  readonly host: string
}

function parseNetworkTarget(origin: string): ParsedNetworkTarget {
  try {
    const url = new URL(origin)
    return { protocol: url.protocol, host: stripIpv6Brackets(url.hostname) }
  } catch {
    // Accept provider-neutral targets that are already bare hosts (or host:port) even though the
    // agent worker normally passes URL origins. Treat them as HTTPS-domain style targets.
    try {
      const url = new URL(`https://${origin}`)
      return { protocol: "https:", host: stripIpv6Brackets(url.hostname) }
    } catch {
      return { protocol: undefined, host: stripIpv6Brackets(origin) }
    }
  }
}

function cidrForHost(host: string): string | undefined {
  const version = isIP(host)
  if (version === 4) {
    return `${host}/32`
  }
  if (version === 6) {
    return `${host}/128`
  }
  return undefined
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.")
}

function stripIpv6Brackets(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "")
}
