import type {
  GitHubPage,
  GitHubPaginationOptions,
  GitHubRequestOptions,
  GitHubUser,
} from "./common"

export interface ListReleasesOptions extends GitHubPaginationOptions, GitHubRequestOptions {}

export interface ListReleaseAssetsOptions extends GitHubPaginationOptions, GitHubRequestOptions {}

export interface CreateReleaseInput {
  readonly tagName: string
  /** Branch or commit SHA the tag is created from when it does not exist yet. */
  readonly targetCommitish?: string
  readonly name?: string
  readonly body?: string
  readonly draft?: boolean
  readonly prerelease?: boolean
  /** Creates a discussion in this category and links it to the release. */
  readonly discussionCategoryName?: string
  /** Generates the name and body from the changes since the previous release. */
  readonly generateReleaseNotes?: boolean
  /** `"legacy"` lets GitHub pick the latest release by creation date and semantic version. */
  readonly makeLatest?: boolean | "legacy"
}

export interface UpdateReleaseInput {
  readonly tagName?: string
  readonly targetCommitish?: string
  readonly name?: string
  readonly body?: string
  readonly draft?: boolean
  readonly prerelease?: boolean
  readonly discussionCategoryName?: string
  readonly makeLatest?: boolean | "legacy"
}

export interface GenerateReleaseNotesInput {
  /** The tag of the release; it need not exist yet. */
  readonly tagName: string
  readonly targetCommitish?: string
  /** Start of the range; defaults to the previous release. */
  readonly previousTagName?: string
  /** Path of a release configuration file in the repository; defaults to `.github/release.yml`. */
  readonly configurationFilePath?: string
}

export interface UploadReleaseAssetInput {
  /** File name of the asset. */
  readonly name: string
  /** Short description shown in place of the file name. */
  readonly label?: string
  readonly data: Blob | ArrayBuffer | Uint8Array
  /** Defaults to the Blob's type, then `application/octet-stream`. */
  readonly contentType?: string
}

export interface UpdateReleaseAssetInput {
  readonly name?: string
  readonly label?: string
}

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
  /** URI template for asset uploads; `assets.upload()` expands it. */
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
  readonly discussion_url?: string
}

export interface GitHubReleaseNotes {
  readonly name: string
  readonly body: string
}

export interface RepositoryReleaseAssetsApi {
  /** List one page of a release's assets. */
  list(
    releaseId: number,
    options?: ListReleaseAssetsOptions
  ): Promise<GitHubPage<GitHubReleaseAsset>>
  get(assetId: number, options?: GitHubRequestOptions): Promise<GitHubReleaseAsset>
  /** Upload a file to the release's `upload_url`. */
  upload(
    release: Pick<GitHubRelease, "upload_url">,
    input: UploadReleaseAssetInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubReleaseAsset>
  update(
    assetId: number,
    patch: UpdateReleaseAssetInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubReleaseAsset>
  delete(assetId: number, options?: GitHubRequestOptions): Promise<void>
}

export interface RepositoryReleasesApi {
  readonly assets: RepositoryReleaseAssetsApi
  /**
   * List one page of this repository's releases, newest first. Drafts are included only when the
   * token has push access to the repository.
   */
  list(options?: ListReleasesOptions): Promise<GitHubPage<GitHubRelease>>
  get(releaseId: number, options?: GitHubRequestOptions): Promise<GitHubRelease>
  /** Get the latest published full release; drafts and prereleases are skipped. */
  getLatest(options?: GitHubRequestOptions): Promise<GitHubRelease>
  /** Get the published release for a tag. Drafts are not returned; GitHub answers 404. */
  getByTag(tag: string, options?: GitHubRequestOptions): Promise<GitHubRelease>
  create(input: CreateReleaseInput, options?: GitHubRequestOptions): Promise<GitHubRelease>
  update(
    releaseId: number,
    patch: UpdateReleaseInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubRelease>
  /** Delete the release. Its tag stays in the repository. */
  delete(releaseId: number, options?: GitHubRequestOptions): Promise<void>
  /** Generate a release name and notes without creating a release. */
  generateNotes(
    input: GenerateReleaseNotesInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubReleaseNotes>
}
