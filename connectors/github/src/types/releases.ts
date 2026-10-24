import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"

export interface ListReleasesOptions extends GitHubPaginationOptions, GitHubRequestOptions {}

export interface GitHubReleaseAsset {
  readonly id: number
  readonly node_id: string
  readonly url: string
  readonly browser_download_url: string
  readonly name: string
  readonly label: string | null
  readonly state: "uploaded" | "open"
  readonly content_type: string
  readonly size: number
  readonly download_count: number
  readonly created_at: string
  readonly updated_at: string
  readonly uploader: GitHubUser | null
}

export interface GitHubRelease {
  readonly id: number
  readonly node_id: string
  readonly url: string
  readonly html_url: string
  readonly assets_url: string
  readonly upload_url: string
  readonly tarball_url: string | null
  readonly zipball_url: string | null
  readonly tag_name: string
  /** The branch or commit the tag is created from when it does not exist yet. */
  readonly target_commitish: string
  readonly name: string | null
  readonly body: string | null
  readonly draft: boolean
  readonly prerelease: boolean
  readonly created_at: string
  /** `null` while the release is a draft. */
  readonly published_at: string | null
  readonly author: GitHubUser
  readonly assets: readonly GitHubReleaseAsset[]
}

export interface RepositoryReleasesApi {
  /**
   * List one page of this repository's releases, newest first. Drafts are included only when the
   * token has push access to the repository.
   */
  list(options?: ListReleasesOptions): Promise<GitHubPage<GitHubRelease>>
  /** Get the published release for a tag. Drafts are not returned; GitHub answers 404. */
  getByTag(tag: string, options?: GitHubRequestOptions): Promise<GitHubRelease>
}
