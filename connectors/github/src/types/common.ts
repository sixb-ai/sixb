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

export interface GitHubUser {
  readonly login: string
  readonly id: number
  readonly node_id: string
  readonly type: string
  readonly html_url: string
  readonly url: string
}
