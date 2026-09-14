import { isIP } from "node:net"
import { SandboxError, type SandboxNetworkPolicy } from "@sixb/core"
import type { SandboxRequestCredential } from "@sixb/core/sandboxes"
import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox"

/** Add host-only injection without widening the configured egress policy. */
export function withRequestCredentials(
  policy: SandboxNetworkPolicy | undefined,
  credentials: readonly SandboxRequestCredential[]
): NetworkPolicy {
  const base = toVercelNetworkPolicy(policy)
  if (!credentials.length) return base
  const invalid = () =>
    new SandboxError("[Sandbox] Invalid or disallowed credential injection target.")
  if (base === "deny-all") throw invalid()
  const allow: Record<string, NetworkPolicyRule[]> =
    base === "allow-all"
      ? { "*": [] }
      : Object.fromEntries((Array.isArray(base.allow) ? base.allow : []).map((host) => [host, []]))
  for (const credential of credentials) {
    let url: URL
    try {
      url = new URL(credential.origin)
    } catch {
      throw invalid()
    }
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.origin !== credential.origin ||
      isIP(url.hostname) ||
      isLoopbackHost(url.hostname) ||
      !credential.path.startsWith("/") ||
      credential.path.startsWith("//") ||
      /[?#%\\\s]/.test(credential.path) ||
      credential.path.split("/").some((part) => part === "." || part === "..") ||
      !["GET", "POST"].includes(credential.method) ||
      !credential.headers ||
      !Object.keys(credential.headers).length ||
      Object.entries(credential.headers).some(
        ([name, value]) =>
          name.toLowerCase() !== "authorization" ||
          typeof value !== "string" ||
          !value ||
          /[\r\n\0]/.test(value)
      ) ||
      (base !== "allow-all" && !Object.hasOwn(allow, url.hostname))
    )
      throw invalid()
    const rules = allow[url.hostname] ?? []
    if (
      rules.some(
        (rule) =>
          rule.match?.path &&
          "exact" in rule.match.path &&
          rule.match.path.exact === credential.path &&
          rule.match.method?.includes(credential.method)
      )
    ) {
      throw invalid()
    }
    rules.push({
      match: { path: { exact: credential.path }, method: [credential.method] },
      transform: [{ headers: { ...credential.headers } }],
    })
    allow[url.hostname] = rules
  }
  return { ...(typeof base === "object" && base.subnets ? { subnets: base.subnets } : {}), allow }
}

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
      throw new SandboxError(
        `[Sandbox] Vercel Sandbox runs remotely and cannot reach restricted target '${target.name}' at ${target.origin}. Use a public HTTPS gateway origin instead of localhost/loopback.`
      )
    }

    const cidr = cidrForHost(origin.host)
    if (cidr) {
      cidrs.add(cidr)
      continue
    }

    if (origin.protocol === "http:") {
      throw new SandboxError(
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
