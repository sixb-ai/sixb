import { AgentToolPublicError } from "@sixb/core"

const MAX_DOMAINS = 1_200
const MAX_FILTER_CHARACTERS = 4_096

interface ExaSearchDomainRule {
  /** Canonical value sent to Exa. */
  readonly value: string
  readonly hostname: string
  readonly wildcard: boolean
  readonly pathPrefix?: string
}

export interface ExaSearchDomainPolicy {
  readonly includeDomains?: readonly string[]
  readonly excludeDomains?: readonly string[]
  assertAllows(url: URL): void
}

/** Compile Exa's hostname, path-prefix, and wildcard syntax once when the tool is defined. */
export function resolveExaSearchDomainPolicy(input: {
  readonly allowedDomains?: readonly string[]
  readonly deniedDomains?: readonly string[]
}): ExaSearchDomainPolicy {
  const allowedRules = normalizeRules(input.allowedDomains, "allowedDomains")
  const deniedRules = normalizeRules(input.deniedDomains, "deniedDomains")

  return {
    ...(allowedRules ? { includeDomains: allowedRules.map((rule) => rule.value) } : {}),
    ...(deniedRules ? { excludeDomains: deniedRules.map((rule) => rule.value) } : {}),
    assertAllows(url) {
      const denied = deniedRules?.some((rule) => matchesRule(url, rule)) ?? false
      if (denied) {
        throw new AgentToolPublicError(
          `[SixbExa] web_search returned a URL denied by domain policy: "${url.hostname}".`
        )
      }
      const allowed = allowedRules?.some((rule) => matchesRule(url, rule)) ?? true
      if (!allowed) {
        throw new AgentToolPublicError(
          `[SixbExa] web_search returned a URL outside the allowed domain policy: "${url.hostname}".`
        )
      }
    },
  }
}

function normalizeRules(
  values: readonly string[] | undefined,
  field: string
): readonly ExaSearchDomainRule[] | undefined {
  if (values === undefined) return undefined
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_DOMAINS) {
    throw new Error(`[SixbExa] ${field} must contain from 1 to ${MAX_DOMAINS} domains.`)
  }

  const rules = new Map<string, ExaSearchDomainRule>()
  for (const value of values) {
    const rule = normalizeRule(value, field)
    rules.set(rule.value, rule)
  }
  return [...rules.values()]
}

function normalizeRule(value: string, field: string): ExaSearchDomainRule {
  if (typeof value !== "string") throw invalidRule(field)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_FILTER_CHARACTERS || trimmed.includes("\\")) {
    throw invalidRule(field)
  }

  const wildcard = trimmed.startsWith("*.")
  const filter = wildcard ? trimmed.slice(2) : trimmed
  const authority = filter.split("/", 1)[0] ?? ""
  if (!authority || /[*:@?#]/.test(authority)) throw invalidRule(field)

  let parsed: URL
  try {
    parsed = new URL(`https://${filter}`)
  } catch {
    throw invalidRule(field)
  }
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw invalidRule(field)
  }

  const hostname = canonicalHostname(parsed.hostname)
  if (!isValidHostname(hostname)) throw invalidRule(field)
  const pathPrefix = normalizePathPrefix(parsed.pathname)
  const normalized = `${wildcard ? "*." : ""}${hostname}${pathPrefix ?? ""}`
  if (normalized.length > MAX_FILTER_CHARACTERS) throw invalidRule(field)

  return {
    value: normalized,
    hostname,
    wildcard,
    ...(pathPrefix ? { pathPrefix } : {}),
  }
}

function matchesRule(url: URL, rule: ExaSearchDomainRule): boolean {
  const hostname = canonicalHostname(url.hostname)
  const hostnameMatches = rule.wildcard
    ? hostname !== rule.hostname && hostname.endsWith(`.${rule.hostname}`)
    : hostname === rule.hostname
  if (!hostnameMatches) return false
  if (!rule.pathPrefix) return true
  return url.pathname === rule.pathPrefix || url.pathname.startsWith(`${rule.pathPrefix}/`)
}

function normalizePathPrefix(pathname: string): string | undefined {
  const normalized = pathname.replace(/\/+$/, "")
  return normalized || undefined
}

function canonicalHostname(value: string): string {
  return value.toLowerCase().replace(/\.$/, "")
}

function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false
  return hostname.split(".").every((label) => {
    if (label.length < 1 || label.length > 63) return false
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  })
}

function invalidRule(field: string): Error {
  return new Error(
    `[SixbExa] ${field} entries must be Exa domain filters without schemes, credentials, ports, queries, or fragments.`
  )
}
