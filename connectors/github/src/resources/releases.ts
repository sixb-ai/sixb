import type { GitHubHttpContext } from "../http"
import {
  applyPaging,
  assertNonEmpty,
  pathId,
  pathPart,
  readJson,
  readNoContent,
  readPage,
  repositoryPath,
  resolvePagePath,
  withQuery,
} from "../http"
import type { GitHubPage, GitHubRepositoryTarget, GitHubRequestOptions } from "../types/common"
import type {
  CreateReleaseInput,
  GenerateReleaseNotesInput,
  GitHubRelease,
  GitHubReleaseAsset,
  GitHubReleaseNotes,
  ListReleaseAssetsOptions,
  ListReleasesOptions,
  RepositoryReleaseAssetsApi,
  RepositoryReleasesApi,
  UpdateReleaseAssetInput,
  UpdateReleaseInput,
  UploadReleaseAssetInput,
} from "../types/releases"

const GITHUB_API_ORIGIN = "https://api.github.com"
const GITHUB_UPLOADS_ORIGIN = "https://uploads.github.com"

export function createRepositoryReleasesApi(
  context: GitHubHttpContext,
  target: GitHubRepositoryTarget
): RepositoryReleasesApi {
  const path = `${repositoryPath(target)}/releases`

  return {
    assets: createRepositoryReleaseAssetsApi(context, path),

    async list(options?: ListReleasesOptions): Promise<GitHubPage<GitHubRelease>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      return readPage<GitHubRelease>(
        await context.http.get(resolvePagePath(withQuery(path, params), options), {
          signal: options?.signal,
        }),
        context.apiBaseUrl
      )
    },

    async get(releaseId: number, options?: GitHubRequestOptions): Promise<GitHubRelease> {
      return readJson<GitHubRelease>(
        await context.http.get(releasePath(path, releaseId), { signal: options?.signal })
      )
    },

    async getLatest(options?: GitHubRequestOptions): Promise<GitHubRelease> {
      return readJson<GitHubRelease>(
        await context.http.get(`${path}/latest`, { signal: options?.signal })
      )
    },

    async getByTag(tag: string, options?: GitHubRequestOptions): Promise<GitHubRelease> {
      return readJson<GitHubRelease>(
        await context.http.get(`${path}/tags/${pathPart(tag, "tag")}`, {
          signal: options?.signal,
        })
      )
    },

    async create(
      input: CreateReleaseInput,
      options?: GitHubRequestOptions
    ): Promise<GitHubRelease> {
      const body = { ...releaseBody(input), generate_release_notes: input.generateReleaseNotes }
      return readJson<GitHubRelease>(
        await context.http.post(path, body, { signal: options?.signal })
      )
    },

    async update(
      releaseId: number,
      patch: UpdateReleaseInput,
      options?: GitHubRequestOptions
    ): Promise<GitHubRelease> {
      return readJson<GitHubRelease>(
        await context.http.request(releasePath(path, releaseId), {
          method: "PATCH",
          body: releaseBody(patch),
          signal: options?.signal,
        })
      )
    },

    async delete(releaseId: number, options?: GitHubRequestOptions): Promise<void> {
      return readNoContent(
        await context.http.request(releasePath(path, releaseId), {
          method: "DELETE",
          signal: options?.signal,
        })
      )
    },

    async generateNotes(
      input: GenerateReleaseNotesInput,
      options?: GitHubRequestOptions
    ): Promise<GitHubReleaseNotes> {
      const body = {
        tag_name: input.tagName,
        target_commitish: input.targetCommitish,
        previous_tag_name: input.previousTagName,
        configuration_file_path: input.configurationFilePath,
      }
      return readJson<GitHubReleaseNotes>(
        await context.http.post(`${path}/generate-notes`, body, { signal: options?.signal })
      )
    },
  }
}

function createRepositoryReleaseAssetsApi(
  context: GitHubHttpContext,
  releasesPath: string
): RepositoryReleaseAssetsApi {
  const assetsPath = `${releasesPath}/assets`

  return {
    async list(
      releaseId: number,
      options?: ListReleaseAssetsOptions
    ): Promise<GitHubPage<GitHubReleaseAsset>> {
      const params = new URLSearchParams()
      applyPaging(params, options)
      const path = withQuery(`${releasePath(releasesPath, releaseId)}/assets`, params)
      return readPage<GitHubReleaseAsset>(
        await context.http.get(resolvePagePath(path, options), { signal: options?.signal }),
        context.apiBaseUrl
      )
    },

    async get(assetId: number, options?: GitHubRequestOptions): Promise<GitHubReleaseAsset> {
      return readJson<GitHubReleaseAsset>(
        await context.http.get(assetPath(assetsPath, assetId), { signal: options?.signal })
      )
    },

    async upload(
      release: Pick<GitHubRelease, "upload_url">,
      input: UploadReleaseAssetInput,
      options?: GitHubRequestOptions
    ): Promise<GitHubReleaseAsset> {
      assertNonEmpty(input.name, "name")
      const url = uploadUrl(release.upload_url, context.apiBaseUrl)
      url.searchParams.set("name", input.name)
      if (input.label) url.searchParams.set("label", input.label)

      const blobType = input.data instanceof Blob ? input.data.type : ""
      const contentType = input.contentType ?? (blobType || "application/octet-stream")

      return readJson<GitHubReleaseAsset>(
        await context.http.post(url.href, input.data, {
          headers: { "content-type": contentType },
          signal: options?.signal,
        })
      )
    },

    async update(
      assetId: number,
      patch: UpdateReleaseAssetInput,
      options?: GitHubRequestOptions
    ): Promise<GitHubReleaseAsset> {
      return readJson<GitHubReleaseAsset>(
        await context.http.request(assetPath(assetsPath, assetId), {
          method: "PATCH",
          body: { name: patch.name, label: patch.label },
          signal: options?.signal,
        })
      )
    },

    async delete(assetId: number, options?: GitHubRequestOptions): Promise<void> {
      return readNoContent(
        await context.http.request(assetPath(assetsPath, assetId), {
          method: "DELETE",
          signal: options?.signal,
        })
      )
    },
  }
}

function releaseBody(input: CreateReleaseInput | UpdateReleaseInput): Record<string, unknown> {
  return {
    tag_name: input.tagName,
    target_commitish: input.targetCommitish,
    name: input.name,
    body: input.body,
    draft: input.draft,
    prerelease: input.prerelease,
    discussion_category_name: input.discussionCategoryName,
    make_latest: input.makeLatest === undefined ? undefined : String(input.makeLatest),
  }
}

function releasePath(releasesPath: string, releaseId: number): string {
  return `${releasesPath}/${pathId(releaseId, "releaseId")}`
}

function assetPath(assetsPath: string, assetId: number): string {
  return `${assetsPath}/${pathId(assetId, "assetId")}`
}

/**
 * Expand a release's `upload_url` template. The token goes with the upload, so the URL must be on
 * the configured host, or on GitHub's upload host when the API is github.com.
 */
function uploadUrl(template: string, apiBaseUrl: URL): URL {
  assertNonEmpty(template, "release.upload_url")
  const url = new URL(template.replace(/\{[^}]*\}$/, ""))

  const trusted =
    url.origin === apiBaseUrl.origin ||
    (apiBaseUrl.origin === GITHUB_API_ORIGIN && url.origin === GITHUB_UPLOADS_ORIGIN)
  if (!trusted) {
    throw new Error("[SixbGitHub] Refusing upload URL outside the configured GitHub host.")
  }

  return url
}
