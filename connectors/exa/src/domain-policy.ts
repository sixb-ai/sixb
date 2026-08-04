import { AgentToolPublicError } from "@sixb/core"

const MAX_DOMAINS = 1_200
const MAX_FILTER_CHARACTERS = 4_096

interface ExaDomainRule {
  /** Canonical value sent to Exa search requests. */
  readonly value: string
  readonly hostname: string
  readonly wildcard: boolean
  readonly pathPrefix?: string
}

interface ExaDomainPolicyCheck {
  readonly toolName: "web_search" | "web_fetch"
  readonly source: "requested" | "returned"
}

export interface ExaDomainPolicy {
  readonly includeDomains?: readonly string[]
  readonly excludeDomains?: readonly string[]
  assertAllows(url: URL, check: ExaDomainPolicyCheck): void
}

/** Compile Exa's hostname, path-prefix, and wildcard syntax once per tool definition. */
export function resolveExaDomainPolicy(input: {
  readonly allowedDomains?: readonly string[]
  readonly deniedDomains?: readonly string[]
}): ExaDomainPolicy {
  const allowedRules = normalizeRules(input.allowedDomains, "allowedDomains")
  const deniedRules = normalizeRules(input.deniedDomains, "deniedDomains")

  return {
    ...(allowedRules ? { includeDomains: allowedRules.map((rule) => rule.value) } : {}),
    ...(deniedRules ? { excludeDomains: deniedRules.map((rule) => rule.value) } : {}),
    assertAllows(url, check) {
      if (deniedRules?.some((rule) => matchesRule(url, rule))) {
        throw domainPolicyError(url, check, "denied")
      }
      if (allowedRules && !allowedRules.some((rule) => matchesRule(url, rule))) {
        throw domainPolicyError(url, check, "outside")
      }
    },
  }
}

function normalizeRules(
  values: readonly string[] | undefined,
  field: string
): readonly ExaDomainRule[] | undefined {
  if (values === undefined) return undefined
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_DOMAINS) {
    throw new Error(`[SixbExa] ${field} must contain from 1 to ${MAX_DOMAINS} domains.`)
  }

  const rules = new Map<string, ExaDomainRule>()
  for (const value of values) {
    const rule = normalizeRule(value, field)
    rules.set(rule.value, rule)
  }
  return [...rules.values()]
}

function normalizeRule(value: string, field: string): ExaDomainRule {
  if (typeof value !== "string") throw invalidRule(field)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_FILTER_CHARACTERS || /[\\?#]/.test(trimmed)) {
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
  if (parsed.username || parsed.password || parsed.port) {
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

function matchesRule(url: URL, rule: ExaDomainRule): boolean {
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

function domainPolicyError(
  url: URL,
  check: ExaDomainPolicyCheck,
  reason: "denied" | "outside"
): AgentToolPublicError {
  const subject = check.source === "requested" ? "requested URL" : "returned URL"
  const policy =
    reason === "denied" ? "denied by domain policy" : "outside the allowed domain policy"
  return new AgentToolPublicError(
    `[SixbExa] ${check.toolName} ${subject} is ${policy}: "${canonicalHostname(url.hostname)}".`
  )
}

function invalidRule(field: string): Error {
  return new Error(
    `[SixbExa] ${field} entries must be Exa domain filters without schemes, credentials, ports, queries, or fragments.`
  )
}
