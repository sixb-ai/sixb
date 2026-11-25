import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import type { SandboxNetworkPolicy, SandboxNetworkTarget } from "@sixb/core"

/** Where a branch installs its packages from: the registries Bun and npm use by default. */
export const PACKAGE_REGISTRIES: readonly SandboxNetworkTarget[] = [
  { name: "npm registry", origin: "https://registry.npmjs.org" },
  { name: "yarn registry", origin: "https://registry.yarnpkg.com" },
]

/**
 * What a branch's sandbox may reach, and nothing more: production's PostgreSQL instance, as its
 * role; production's API, for the lake's files; the git host, to pull; the package registries;
 * the providers of the project's models, for its agents, workflows and embeddings; and whatever
 * the deployment adds for the branch's `dev` values. Every other address is refused
 * by the provider, private ranges, link-local and the cloud's metadata endpoint included.
 *
 * Production's instance is named by its addresses, resolved now: PostgreSQL negotiates TLS after
 * the connection opens, so a firewall that reads TLS names cannot match its host name. A new
 * sandbox resolves them again.
 */
export async function branchNetwork(input: {
  readonly gitUrl: string
  readonly apiPublicOrigin: string | undefined
  readonly database: { readonly host: string; readonly port: number }
  /** Where the project's models are called, as their providers said (`modelOriginsOf`). */
  readonly models?: readonly string[]
  readonly allow?: readonly SandboxNetworkTarget[]
}): Promise<SandboxNetworkPolicy> {
  const allow: SandboxNetworkTarget[] = []

  const git = httpsOrigin(input.gitUrl)
  if (git) allow.push({ name: "git host", origin: git })
  allow.push(...PACKAGE_REGISTRIES)
  if (input.apiPublicOrigin) allow.push({ name: "production API", origin: input.apiPublicOrigin })

  for (const address of await addresses(input.database.host)) {
    const host = isIP(address) === 6 ? `[${address}]` : address
    allow.push({ name: "production PostgreSQL", origin: `https://${host}:${input.database.port}` })
  }

  for (const origin of input.models ?? []) allow.push({ name: "model provider", origin })
  allow.push(...(input.allow ?? []))
  return { mode: "restricted", allow: dedupe(allow) }
}

/** The git host's origin, for a repository git reaches over HTTPS; none for a path on disk. */
function httpsOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" ? parsed.origin : null
  } catch {
    return null
  }
}

async function addresses(host: string): Promise<readonly string[]> {
  if (isIP(host)) return [host]
  const found = await lookup(host, { all: true })
  return found.map((entry) => entry.address)
}

function dedupe(targets: readonly SandboxNetworkTarget[]): SandboxNetworkTarget[] {
  const seen = new Set<string>()
  return targets.filter((target) => {
    if (seen.has(target.origin)) return false
    seen.add(target.origin)
    return true
  })
}
