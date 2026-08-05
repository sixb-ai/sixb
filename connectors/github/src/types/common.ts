export interface GitHubRepositoryTarget {
  readonly owner: string
  readonly repo: string
}

export interface GitHubPaginationOptions {
  /** Results per page, 1-100 (defaults to GitHub's 30). */
  readonly pageSize?: number
  /** Opaque token returned by a previous page. */
  readonly pageToken?: string
}

export interface GitHubPage<T> {
  readonly items: readonly T[]
  readonly hasMore: boolean
  readonly nextPageToken?: string
  readonly previousPageToken?: string
}

/** GitHub's `simple-user` representation embedded in lists and other resources. */
export interface GitHubUser {
  /** Included by a few user endpoints in addition to the normal simple-user fields. */
  readonly name?: string | null
  readonly email?: string | null
  readonly login: string
  readonly id: number
  readonly node_id: string
  readonly avatar_url: string
  readonly gravatar_id: string | null
  readonly url: string
  readonly html_url: string
  readonly followers_url: string
  readonly following_url: string
  readonly gists_url: string
  readonly starred_url: string
  readonly subscriptions_url: string
  readonly organizations_url: string
  readonly repos_url: string
  readonly events_url: string
  readonly received_events_url: string
  readonly type: string
  readonly site_admin: boolean
  readonly starred_at?: string
  readonly user_view_type?: string
}
