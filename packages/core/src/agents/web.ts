import { createSixbError } from "../errors/internal"
import type { ModelCatalog } from "../models/catalog"
import type { AiModelCallRecorder } from "../models/execution/model-call-recorder"
import { bindWebSearchModels } from "../models/execution/web-search"
import { RuntimeError } from "../runtime/errors"
import type { AgentRunModels } from "./run-session"
import type { AgentDefinitions } from "./skills"

// The Agent's web tools: the option that narrows or turns them off, the domain lists both tools
// apply, and the search a run's tool calls through its own accounting.

/** Narrows what the Agent's web tools reach. */
export interface AgentWebOptions {
  /**
   * Only these: `docs.example.com`, `*.example.com` (its subdomains, not itself) or a path prefix
   * such as `example.com/guides`.
   */
  readonly allowedDomains?: readonly string[]
  /** Never these, in the same syntax; they win over `allowedDomains`. */
  readonly blockedDomains?: readonly string[]
}

/** The tool names Sixb gives the Agent for the web, offered unless `agent.web` is `false`. */
export const AGENT_WEB_TOOL_NAMES = ["web_search", "web_fetch"] as const

const MAX_DOMAINS = 1_200
const MAX_RULE_CHARACTERS = 4_096

/**
 * Check `agent.web` and return it with each domain rule in its canonical form: lowercase, without
 * a trailing dot or slash, duplicates dropped.
 */
export function resolveAgentWebOptions(value: unknown): false | AgentWebOptions | undefined {
  if (value === undefined || value === false) return value

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeError(
      "[Sixb] agent.web must be false, or { allowedDomains?, blockedDomains? }."
    )
  }

  for (const key of Object.keys(value)) {
    if (key !== "allowedDomains" && key !== "blockedDomains") {
      throw new RuntimeError(
        `[Sixb] agent.web has an unknown option '${key}': use allowedDomains or blockedDomains.`
      )
    }
  }

  const options = value as Record<string, unknown>
  const allowedDomains = canonicalRules(options.allowedDomains, "allowedDomains")
  const blockedDomains = canonicalRules(options.blockedDomains, "blockedDomains")

  return Object.freeze({
    ...(allowedDomains ? { allowedDomains } : {}),
    ...(blockedDomains ? { blockedDomains } : {}),
  })
}

/**
 * Refuse a language model whose provider runs a tool under a name the Agent's web tools take: a
 * request would declare the name twice. Checked unless `agent.web` is `false`; `web_search` only
 * when the project has a search backend, since the Agent offers none without one.
 */
export function assertNoProviderWebTools(models: ModelCatalog | undefined): void {
  const offered: readonly string[] = models?.webSearch ? AGENT_WEB_TOOL_NAMES : ["web_fetch"]

  for (const { provider, modelId, model } of models?.language?.list() ?? []) {
    const name = model.providerToolNames?.find((tool) => offered.includes(tool))
    if (name === undefined) continue

    throw new RuntimeError(
      `[Sixb] Language model '${provider}/${modelId}' declares the provider tool '${name}', a name Sixb gives the Agent's own web tool. Remove it from providerTools, or set agent.web: false to keep the provider's.`
    )
  }
}

/** What the domain lists say of a URL. */
export interface WebDomainPolicy {
  /** Why the lists refuse the URL, or undefined when they allow it. */
  refuses(url: URL): "blocked" | "not-allowed" | undefined
}

/** Compile domain lists `resolveAgentWebOptions` already checked. */
export function webDomainPolicy(options: AgentWebOptions): WebDomainPolicy {
  const allowed = options.allowedDomains?.map((rule) => parseRule(rule, "allowedDomains"))
  const blocked = options.blockedDomains?.map((rule) => parseRule(rule, "blockedDomains"))

  return {
    refuses(url) {
      if (blocked?.some((rule) => matchesRule(url, rule))) return "blocked"
      if (allowed && !allowed.some((rule) => matchesRule(url, rule))) return "not-allowed"
      return undefined
    },
  }
}

/**
 * A run's web search, through the project's web search model: admitted, bounded and recorded with
 * the run's other model calls.
 */
export function bindAgentWebSearch(
  definitions: {
    readonly agent: Pick<AgentDefinitions, "web">
    readonly models?: Pick<ModelCatalog, "webSearch">
  },
  execution: {
    /** Aborts once the run ends or is cancelled. */
    readonly signal: AbortSignal
    readonly accounting: () => Promise<AiModelCallRecorder>
  }
): AgentRunModels["webSearch"] {
  const bound = bindWebSearchModels(definitions.models?.webSearch, {
    signal: (signal) => (signal ? AbortSignal.any([execution.signal, signal]) : execution.signal),
    accounting: execution.accounting,
  })

  return async (request, signal) => {
    // A runner asks for a search through its session: the project's options decide, not its plan.
    if (definitions.agent.web === false) {
      throw createSixbError(
        "agent.execution_failed",
        "[Sixb] The Agent's web tools are off: agent.web is false."
      )
    }

    if (!bound) {
      throw createSixbError(
        "agent.execution_failed",
        "[Sixb] The project has no web search model: set models.webSearch, or use a language model that offers one."
      )
    }

    return bound.default.model.search({ ...request, signal })
  }
}

interface DomainRule {
  readonly hostname: string
  readonly wildcard: boolean
  readonly pathPrefix?: string
}

function canonicalRules(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined

  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DOMAINS) {
    throw new RuntimeError(`[Sixb] agent.web.${field} must list from 1 to ${MAX_DOMAINS} domains.`)
  }

  const rules = new Set<string>()
  for (const entry of value) rules.add(canonicalRule(parseRule(entry, field)))

  return Object.freeze([...rules])
}

function parseRule(value: unknown, field: string): DomainRule {
  if (typeof value !== "string") throw invalidRule(field, value)

  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_RULE_CHARACTERS || /[\\?#]/.test(trimmed)) {
    throw invalidRule(field, value)
  }

  const wildcard = trimmed.startsWith("*.")
  const filter = wildcard ? trimmed.slice(2) : trimmed
  const authority = filter.split("/", 1)[0] ?? ""
  if (!authority || /[*:@]/.test(authority)) throw invalidRule(field, value)

  let parsed: URL
  try {
    parsed = new URL(`https://${filter}`)
  } catch {
    throw invalidRule(field, value)
  }

  const hostname = canonicalHostname(parsed.hostname)
  if (!isValidHostname(hostname)) throw invalidRule(field, value)

  const pathPrefix = parsed.pathname.replace(/\/+$/, "")
  return { hostname, wildcard, ...(pathPrefix ? { pathPrefix } : {}) }
}

function canonicalRule(rule: DomainRule): string {
  return `${rule.wildcard ? "*." : ""}${rule.hostname}${rule.pathPrefix ?? ""}`
}

function matchesRule(url: URL, rule: DomainRule): boolean {
  const hostname = canonicalHostname(url.hostname)
  const hostnameMatches = rule.wildcard
    ? hostname !== rule.hostname && hostname.endsWith(`.${rule.hostname}`)
    : hostname === rule.hostname
  if (!hostnameMatches) return false

  if (!rule.pathPrefix) return true
  return url.pathname === rule.pathPrefix || url.pathname.startsWith(`${rule.pathPrefix}/`)
}

function canonicalHostname(value: string): string {
  return value.toLowerCase().replace(/\.$/, "")
}

function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false

  return hostname
    .split(".")
    .every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
}

function invalidRule(field: string, value: unknown): RuntimeError {
  return new RuntimeError(
    `[Sixb] agent.web.${field} has an invalid entry ${JSON.stringify(value)}: write a domain such as 'example.com', '*.example.com' or 'example.com/docs', without a scheme, port, query or credentials.`
  )
}
