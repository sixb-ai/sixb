import type {
  Client,
  CreatePageParameters,
  GetPageParameters,
  GetPagePropertyParameters,
  GetPagePropertyResponse,
  MovePageParameters,
  PageObjectResponse,
  PartialPageObjectResponse,
  UpdatePageParameters,
} from "@notionhq/client"
import type { ConnectorAdapter } from "@sixb/core"

export type NotionTokenResolver = string | (() => string | Promise<string>)

export interface NotionConnectorOptions {
  readonly token: NotionTokenResolver
  /** Defaults to https://api.notion.com/v1/. Useful for proxies and tests. */
  readonly baseUrl?: string
  /** Per-attempt timeout; defaults to 30 seconds. */
  readonly timeoutMs?: number
  /** Request pacing per connected client; defaults to 350 ms. */
  readonly minDelayMs?: number
  /** Bounded HTTP retries; defaults to 2. Set to 0 to disable. */
  readonly maxRetries?: number
}

export interface NotionRequestOptions {
  readonly signal?: AbortSignal
}

/** API version 2026-03-11 removed the legacy archived field. */
export type NotionPage = Omit<PageObjectResponse, "archived">
export type NotionPageResponse = NotionPage | PartialPageObjectResponse
export type NotionRetrievePageParameters = GetPageParameters
export type NotionRetrievePropertyParameters = GetPagePropertyParameters
export type NotionPropertyResponse = GetPagePropertyResponse
export type NotionMovePageParameters = MovePageParameters
export type NotionUpdatePageParameters = Omit<UpdatePageParameters, "archived">

/** V1 returns pages synchronously; async-task polling is outside this client. */
export type NotionCreatePageParameters = Omit<CreatePageParameters, "allow_async"> & {
  allow_async?: false
}

export type NotionRetrieveMarkdownParameters = Omit<
  Parameters<Client["pages"]["retrieveMarkdown"]>[0],
  "auth"
>
export type NotionMarkdownResponse = Awaited<ReturnType<Client["pages"]["retrieveMarkdown"]>>

type SynchronousMarkdown<T> = T extends unknown
  ? Omit<T, "auth" | "allow_async"> & { allow_async?: false }
  : never

export type NotionUpdateMarkdownParameters = SynchronousMarkdown<
  Parameters<Client["pages"]["updateMarkdown"]>[0]
>

export interface NotionPagesResource {
  retrieve(
    parameters: NotionRetrievePageParameters,
    options?: NotionRequestOptions
  ): Promise<NotionPageResponse>
  create(
    parameters: NotionCreatePageParameters,
    options?: NotionRequestOptions
  ): Promise<NotionPageResponse>
  update(
    parameters: NotionUpdatePageParameters,
    options?: NotionRequestOptions
  ): Promise<NotionPageResponse>
  move(
    parameters: NotionMovePageParameters,
    options?: NotionRequestOptions
  ): Promise<NotionPageResponse>
  trash(
    parameters: Pick<NotionRetrievePageParameters, "page_id">,
    options?: NotionRequestOptions
  ): Promise<NotionPageResponse>
  restore(
    parameters: Pick<NotionRetrievePageParameters, "page_id">,
    options?: NotionRequestOptions
  ): Promise<NotionPageResponse>
  retrieveMarkdown(
    parameters: NotionRetrieveMarkdownParameters,
    options?: NotionRequestOptions
  ): Promise<NotionMarkdownResponse>
  updateMarkdown(
    parameters: NotionUpdateMarkdownParameters,
    options?: NotionRequestOptions
  ): Promise<NotionMarkdownResponse>
  readonly properties: {
    /** Returns one scalar property or one cursor-paginated list, without flattening rollups. */
    retrieve(
      parameters: NotionRetrievePropertyParameters,
      options?: NotionRequestOptions
    ): Promise<NotionPropertyResponse>
  }
}

export interface NotionClient {
  readonly pages: NotionPagesResource
}

export type NotionConnector = ConnectorAdapter<"notion", NotionClient>

export type {
  BlockObjectRequest,
  PartialPageObjectResponse,
  PropertyItemListResponse,
  PropertyItemObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client"
