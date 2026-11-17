/** The App's OAuth client, as the connector that issued a person's tokens holds it. */
export interface GitHubOAuthClient {
  readonly clientId: string
  /** The connector's API base URL, with a trailing slash: `https://api.github.com/` by default. */
  readonly apiBaseUrl: string
  /** `Basic` credentials for the App's `/applications/{client_id}/…` endpoints. */
  readonly authorization: string
}

/**
 * Each OAuth `github()` adapter's client, so `githubOAuth()` scopes and revokes a run's token with
 * the App that issued the person's token. Kept here rather than on the adapter, which project code
 * may log or serialize.
 */
const oauthClients = new WeakMap<object, GitHubOAuthClient>()

export function registerGitHubOAuthClient(adapter: object, client: GitHubOAuthClient): void {
  oauthClients.set(adapter, client)
}

export function githubOAuthClientOf(adapter: unknown): GitHubOAuthClient | undefined {
  return typeof adapter === "object" && adapter !== null ? oauthClients.get(adapter) : undefined
}
