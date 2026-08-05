import type { GitHubPage, GitHubPaginationOptions, GitHubUser } from "./common"

export interface ListUsersOptions extends GitHubPaginationOptions {
  /** Only return users whose numeric ID is greater than this value. */
  readonly since?: number
}

export interface GitHubUserPlan {
  readonly name: string
  readonly space: number
  readonly private_repos: number
  readonly collaborators: number
}

/** A full GitHub user profile returned by `GET /user` or `GET /users/{username}`. */
export interface GitHubUserProfile extends GitHubUser {
  readonly name: string | null
  readonly company: string | null
  readonly blog: string | null
  readonly location: string | null
  readonly email: string | null
  readonly notification_email?: string | null
  readonly hireable: boolean | null
  readonly bio: string | null
  readonly twitter_username?: string | null
  readonly public_repos: number
  readonly public_gists: number
  readonly followers: number
  readonly following: number
  readonly created_at: string
  readonly updated_at: string
  /** Private fields are present only when the token can view them. */
  readonly private_gists?: number
  readonly total_private_repos?: number
  readonly owned_private_repos?: number
  readonly disk_usage?: number
  readonly collaborators?: number
  readonly two_factor_authentication?: boolean
  readonly plan?: GitHubUserPlan
  readonly business_plus?: boolean
  readonly ldap_dn?: string
}

export interface GitHubUsersApi {
  /** Get the authenticated user's profile, including private fields when GitHub returns them. */
  getAuthenticated(): Promise<GitHubUserProfile>
  /** Get a user by login. */
  get(username: string): Promise<GitHubUserProfile>
  /** Get a user by their durable numeric account ID. */
  getById(accountId: number): Promise<GitHubUserProfile>
  /** List one page of all GitHub users, ordered by signup ID. */
  list(options?: ListUsersOptions): Promise<GitHubPage<GitHubUser>>
}
