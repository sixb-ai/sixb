import { isIP } from "node:net"
import { SandboxError, type SandboxNetworkPolicy } from "@sixb/core"
import type { SandboxRequestCredential, SandboxRequestMethod } from "@sixb/core/sandboxes"
import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox"

/** Add host-only injection without widening the configured egress policy. */
export function withRequestCredentials(
  policy: SandboxNetworkPolicy | undefined,
  credentials: readonly SandboxRequestCredential[]
): NetworkPolicy {
  const base = toVercelNetworkPolicy(policy)
  if (!credentials.length) return base
  if (base === "deny-all") throw invalid("the sandbox network allows no domain")

  const allow: Record<string, NetworkPolicyRule[]> =
    base === "allow-all"
      ? { "*": [] }
      : Object.fromEntries((Array.isArray(base.allow) ? base.allow : []).map((host) => [host, []]))

  // The requests each host already injects into: a request gets at most one credential.
  const granted = new Map<string, CredentialMatch[]>()

  for (const credential of credentials) {
    const host = credentialHost(credential.origin)
    if (base !== "allow-all" && !Object.hasOwn(allow, host)) {
      throw invalid(`${host} is not in the sandbox network`)
    }

    const match = credentialMatch(credential)
    validateHeaders(credential.headers)

    // Vercel evaluates a host's rules in order and the first match wins, so a credential that
    // overlaps an earlier one would be silently shadowed. The contract injects one credential
    // per request: an overlap is ambiguous, so it is rejected rather than ordered.
    const previous = granted.get(host) ?? []
    if (previous.some((other) => overlaps(other, match))) {
      throw invalid(`overlaps another credential on ${host}`)
    }
    granted.set(host, [...previous, match])

    const rules = allow[host] ?? []
    rules.push({
      match: {
        path: match.prefix ? { startsWith: match.path } : { exact: match.path },
        method: [...match.methods],
      },
      // The firewall matches the domain on TLS SNI only. Forcing Host to that domain keeps a
      // request that names another one in its Host header (domain fronting) from receiving the
      // credential there.
      transform: [{ headers: { ...credential.headers, Host: host } }],
    })
    allow[host] = rules
  }

  return { ...(typeof base === "object" && base.subnets ? { subnets: base.subnets } : {}), allow }
}

const REQUEST_METHODS: readonly SandboxRequestMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"]

/** The requests one credential selects, once its path and methods are validated. */
interface CredentialMatch {
  readonly path: string
  /** Select every path starting with `path`, not `path` alone. */
  readonly prefix: boolean
  readonly methods: readonly SandboxRequestMethod[]
}

/** Name the rule a credential breaks. Never include its headers: they hold the secret. */
function invalid(reason: string): SandboxError {
  return new SandboxError(`[Sandbox] Invalid request credential: ${reason}.`)
}

/** The one public HTTPS domain a credential targets, as both firewall key and Host header. */
function credentialHost(origin: unknown): string {
  let url: URL
  try {
    url = new URL(String(origin))
  } catch {
    throw invalid("origin must be an https:// origin")
  }

  if (url.protocol !== "https:" || url.port || url.origin !== origin) {
    throw invalid("origin must be an https:// origin, without path, port or user info")
  }

  if (isIP(url.hostname) || isLoopbackHost(url.hostname)) {
    throw invalid("origin must name a public domain, not an IP address or loopback host")
  }

  // Vercel reads "*" in a domain as a wildcard: one credential would open every matching domain.
  if (url.hostname.includes("*")) throw invalid("wildcard hosts are not allowed")

  return url.host
}

function credentialMatch(credential: SandboxRequestCredential): CredentialMatch {
  return { ...selectPath(credential.path), methods: selectMethods(credential.method) }
}

/** One exact path, or every path under a prefix. */
function selectPath(path: unknown): Pick<CredentialMatch, "path" | "prefix"> {
  if (typeof path === "string") return { path: requestPath(path), prefix: false }

  if (!isPrefixOnly(path)) throw invalid("path must be a string or an object with only `prefix`")

  const { prefix } = path
  if (typeof prefix !== "string") throw invalid("path prefix must be a string")

  // A prefix stops at a segment boundary: "/acme/" never selects "/acme-x".
  if (!prefix.endsWith("/")) throw invalid('path prefix must end with "/"')

  return { path: requestPath(prefix), prefix: true }
}

/** `{ prefix }` and nothing else: another key could be a matcher this provider would ignore. */
function isPrefixOnly(path: unknown): path is { readonly prefix: unknown } {
  if (typeof path !== "object" || path === null) return false

  const keys = Object.keys(path)
  return keys.length === 1 && keys[0] === "prefix"
}

/**
 * The contract's request path: absolute, printable ASCII, and free of anything a client or
 * server could decode or normalize into another path (query, fragment, escapes, backslashes,
 * dot segments), so the path the firewall matches is the one the server serves.
 */
function requestPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw invalid('path must start with a single "/"')
  }

  if (!/^[\x21-\x7e]+$/.test(path)) {
    throw invalid("path must be printable ASCII, without spaces or control characters")
  }

  if (/[?#%\\]/.test(path)) throw invalid('path must not contain "?", "#", "%" or "\\"')

  if (path.split("/").some((part) => part === "." || part === "..")) {
    throw invalid('path must not contain "." or ".." segments')
  }

  return path
}

/** One method, or a list. Always listed: an empty list never means "any method". */
function selectMethods(method: unknown): readonly SandboxRequestMethod[] {
  if (typeof method !== "string" && !Array.isArray(method)) {
    throw invalid("method must be one method or a list of methods")
  }

  // Array.from turns holes into undefined, so a sparse list fails the checks below.
  const methods: readonly unknown[] = typeof method === "string" ? [method] : Array.from(method)
  if (!methods.length) throw invalid("method list must not be empty")

  if (!methods.every(isRequestMethod)) {
    throw invalid(`method must be one of ${REQUEST_METHODS.join(", ")}`)
  }

  if (new Set(methods).size !== methods.length)
    throw invalid("method list must not repeat a method")

  return methods
}

function isRequestMethod(value: unknown): value is SandboxRequestMethod {
  return REQUEST_METHODS.some((method) => method === value)
}

/** Headers set only Authorization, as one non-empty line: never Host or another header. */
function validateHeaders(headers: unknown): void {
  if (typeof headers !== "object" || headers === null || !Object.keys(headers).length) {
    throw invalid("headers must set Authorization")
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "authorization") {
      throw invalid("headers may only set Authorization")
    }

    if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) {
      throw invalid("Authorization must be a non-empty single-line value")
    }
  }
}

/** Whether one request could match both: a shared method and a path both select. */
function overlaps(a: CredentialMatch, b: CredentialMatch): boolean {
  const sharedMethod = a.methods.some((method) => b.methods.includes(method))
  const sharedPath =
    a.path === b.path ||
    (a.prefix && b.path.startsWith(a.path)) ||
    (b.prefix && a.path.startsWith(b.path))

  return sharedMethod && sharedPath
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

    // Vercel reads "*" in a domain as a wildcard, which would open every matching domain.
    if (origin.host.includes("*")) {
      throw new SandboxError(
        `[Sandbox] Network target '${target.name}' (${target.origin}) uses a wildcard host, which Vercel Sandbox would read as every matching domain. List each domain the sandbox needs.`
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
