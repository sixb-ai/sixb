import type { AuthorizablePrincipal, SixbHostView } from "@sixb/core"
import { sourceGitUrl } from "@sixb/core/internal/branches"
import { getSandboxConnectionTokenAccess } from "@sixb/core/internal/connector-connections"
import type { SandboxConnectionTokenResolver, SandboxSourceCredentials } from "@sixb/core/sandboxes"

/**
 * Read access to the project's repository from its source authentication, null without one. An
 * OAuth source (`githubOAuth`) reads with the connector connection it names, as an agent's
 * workspace does: the branch creator's own for a branch, the project's for the read of every
 * branch at once. Without a person to read as, it uses its `fallback`, if it has one.
 */
export async function authorizeSourceRead(
  host: SixbHostView,
  input: { readonly signal: AbortSignal; readonly requestedBy?: AuthorizablePrincipal }
): Promise<SandboxSourceCredentials | null> {
  const auth = host.sandboxDefinition?.auth
  if (!auth || !host.source) return null

  const connectionToken = connectionTokens(host, input.requestedBy)
  return auth.authorize({
    source: { type: "git", url: sourceGitUrl(host.source), access: "read" },
    signal: input.signal,
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    ...(connectionToken ? { connectionToken } : {}),
  })
}

/**
 * Tokens of the connections an OAuth source names, one source per connection: a token it
 * invalidates is fetched again from the same source, as `githubOAuth` does after GitHub's 404.
 */
function connectionTokens(
  host: SixbHostView,
  requestedBy: AuthorizablePrincipal | undefined
): SandboxConnectionTokenResolver | undefined {
  const access = getSandboxConnectionTokenAccess(host)
  if (!access) return undefined

  const sources = new Map<string, ReturnType<typeof access>>()
  return (connector, selector) => {
    const key = JSON.stringify([connector.id, selector.owner, selector.slot])
    let source = sources.get(key)
    if (!source) {
      source = access({ connector, selector, ...(requestedBy ? { requestedBy } : {}) })
      sources.set(key, source)
    }
    return source.get()
  }
}
