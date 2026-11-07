import type { GitHubRequestOptions } from "./common"

/**
 * How GitHub returns an issue's or comment's body: `raw` returns the Markdown in `body` (the
 * default), `text` returns `body_text` instead of `body`, `html` returns `body_html` instead of
 * `body`, and `full` returns all three. Only `raw` and `full` include `body`.
 */
export type GitHubBodyFormat = "raw" | "text" | "html" | "full"

export interface GitHubBodyFormatOptions {
  readonly bodyFormat?: GitHubBodyFormat
}

/** An image, video or file attached to an issue, a pull request or a comment. */
export interface GitHubAttachment {
  /** The asset's UUID for images and videos, the file's id for other files. */
  readonly id: string
  /** `media` for images and videos, `file` for other attached files. */
  readonly kind: "media" | "file"
  /** The link as written in the Markdown body. */
  readonly url: string
  /**
   * Where `download()` fetches it: the short-lived signed link from `body_html` when the body
   * carried one, else `url`.
   */
  readonly downloadUrl: string
  /** The file's name, for attached files. */
  readonly name?: string
}

/** The body of an issue, pull request or comment, as returned with a `bodyFormat`. */
export interface GitHubAttachmentSource {
  readonly body?: string | null
  readonly body_html?: string | null
}

export interface GitHubAttachmentsApi {
  /** The attachments a body links to, in the order they appear, each once. */
  find(source: GitHubAttachmentSource): GitHubAttachment[]
  /** Download an attachment found by `find()`. The token is never sent. */
  download(
    attachment: Pick<GitHubAttachment, "downloadUrl">,
    options?: GitHubRequestOptions
  ): Promise<Response>
}
