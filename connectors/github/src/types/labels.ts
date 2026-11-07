import type { GitHubPage, GitHubPaginationOptions, GitHubRequestOptions } from "./common"
import type { GitHubLabel } from "./issues"

export interface ListLabelsOptions extends GitHubPaginationOptions, GitHubRequestOptions {}

export interface CreateLabelInput {
  readonly name: string
  /** Six hex digits, with or without a leading `#`, such as `d73a4a`. */
  readonly color: string
  readonly description?: string | null
}

export interface UpdateLabelInput {
  /** Renames the label; issues keep it under the new name. */
  readonly newName?: string
  /** Six hex digits, with or without a leading `#`. */
  readonly color?: string
  readonly description?: string | null
}

export interface RepositoryLabelsApi {
  /** List one page of this repository's labels. */
  list(options?: ListLabelsOptions): Promise<GitHubPage<GitHubLabel>>
  /** Get a label by name. Names may contain spaces and `/`. */
  get(name: string, options?: GitHubRequestOptions): Promise<GitHubLabel>
  create(input: CreateLabelInput, options?: GitHubRequestOptions): Promise<GitHubLabel>
  update(
    name: string,
    patch: UpdateLabelInput,
    options?: GitHubRequestOptions
  ): Promise<GitHubLabel>
  /** Delete a label, removing it from every issue and pull request. */
  delete(name: string, options?: GitHubRequestOptions): Promise<void>
}
