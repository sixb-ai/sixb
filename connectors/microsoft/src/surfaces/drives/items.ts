import { readResponseBody } from "@sixb/connector-rest"
import {
  MicrosoftApiError,
  MicrosoftConfigurationError,
  MicrosoftProtocolError,
} from "../../errors"
import { isRecord } from "../../guards"
import { checkEmpty, type MicrosoftHttp } from "../../http"
import { allPages, page } from "../../pagination"
import type {
  ConflictBehavior,
  GraphPage,
  ListOptions,
  RequestOptions,
  SelectOptions,
  WriteOptions,
} from "../../types/common"
import type { DriveItem, DriveItemPreview } from "../../types/files"
import { fileName, filePath, httpsUrl, nonEmpty, query, resource } from "../../validation"
import { drivePath, itemPath } from "./paths"

export interface CreateFolderOptions extends RequestOptions {
  readonly conflictBehavior?: "fail" | "rename"
}

export interface MoveOptions extends WriteOptions {
  readonly name?: string
}

export interface PreviewOptions extends RequestOptions {
  /** Page to open, when the format has pages. */
  readonly page?: string | number
  /** Zoom level to open at, when the viewer supports it. */
  readonly zoom?: number
  /** Graph picks a suitable viewer when omitted. */
  readonly viewer?: "onedrive" | "office"
  /** Graph defaults to true: the embedded view shows no controls. */
  readonly chromeless?: boolean
}

export interface DriveItemsResource {
  get(driveId: string, itemId: string, options?: SelectOptions): Promise<DriveItem>
  /** Unencoded path relative to the library root. */
  getByPath(driveId: string, path: string, options?: SelectOptions): Promise<DriveItem>
  listChildren(
    driveId: string,
    parentId?: string,
    options?: ListOptions
  ): Promise<GraphPage<DriveItem>>
  listAllChildren(
    driveId: string,
    parentId?: string,
    options?: ListOptions
  ): AsyncIterable<DriveItem>
  download(driveId: string, itemId: string, options?: RequestOptions): Promise<Uint8Array>
  /** Consume or cancel response.body; it remains bound to the request lifetime. */
  downloadResponse(driveId: string, itemId: string, options?: RequestOptions): Promise<Response>
  /**
   * Embeddable viewer URLs, valid for anyone who holds them. The connector acts as the application,
   * so check that the person who will see the preview may read this item before calling it.
   */
  preview(driveId: string, itemId: string, options?: PreviewOptions): Promise<DriveItemPreview>
  createFolder(
    driveId: string,
    parentId: string,
    name: string,
    options?: CreateFolderOptions
  ): Promise<DriveItem>
  rename(driveId: string, itemId: string, name: string, options?: WriteOptions): Promise<DriveItem>
  /** Within one drive only. "root" is resolved to the actual root folder ID. */
  move(driveId: string, itemId: string, parentId: string, options?: MoveOptions): Promise<DriveItem>
  /** Moves the item to the recycle bin, subject to SharePoint retention rules. */
  delete(driveId: string, itemId: string, options?: WriteOptions): Promise<void>
}

export function writeHeaders(options?: WriteOptions): HeadersInit {
  return options?.ifMatch !== undefined ? { "If-Match": nonEmpty(options.ifMatch, "ifMatch") } : {}
}

export function conflict(
  value: ConflictBehavior | undefined,
  fallback: ConflictBehavior
): ConflictBehavior {
  const result = value ?? fallback
  if (!["fail", "replace", "rename"].includes(result))
    throw new MicrosoftProtocolError("Unsupported conflict behavior.")
  return result
}

function previewBody(options?: PreviewOptions): Record<string, unknown> {
  const { page, zoom, viewer, chromeless } = options ?? {}
  const validPage =
    page === undefined ||
    (typeof page === "string" ? page.trim() !== "" : Number.isSafeInteger(page) && page > 0)
  if (!validPage)
    throw new MicrosoftConfigurationError("page must be a positive integer or a non-empty string.")
  if (zoom !== undefined && !(Number.isFinite(zoom) && zoom > 0))
    throw new MicrosoftConfigurationError("zoom must be a positive number.")
  if (viewer !== undefined && viewer !== "onedrive" && viewer !== "office")
    throw new MicrosoftConfigurationError("viewer must be onedrive or office.")
  if (chromeless !== undefined && typeof chromeless !== "boolean")
    throw new MicrosoftConfigurationError("chromeless must be a boolean.")
  return Object.fromEntries(
    Object.entries({ page, zoom, viewer, chromeless }).filter(([, value]) => value !== undefined)
  )
}

function previewInfo(value: unknown): DriveItemPreview {
  if (!isRecord(value)) throw new MicrosoftProtocolError("Graph returned an invalid preview.")
  const preview = { ...value }
  // Graph can return null for unused preview fields; expose them as absent optional strings.
  for (const key of ["getUrl", "postUrl", "postParameters"]) {
    if (preview[key] === null) delete preview[key]
  }
  const { getUrl, postUrl, postParameters } = preview
  // The caller embeds these in a page: anything but an HTTPS URL could run script there.
  for (const url of [getUrl, postUrl]) {
    if (
      url !== undefined &&
      (typeof url !== "string" || !URL.canParse(url) || new URL(url).protocol !== "https:")
    )
      throw new MicrosoftProtocolError("Graph returned a preview URL that is not HTTPS.")
  }
  if (postParameters !== undefined && typeof postParameters !== "string")
    throw new MicrosoftProtocolError("Graph returned invalid preview postParameters.")
  if (getUrl === undefined && postUrl === undefined)
    throw new MicrosoftProtocolError("Graph returned a preview without a URL.")
  // Provider wire boundary, checked field by field above.
  return preview as DriveItemPreview
}

export function itemsResource(http: MicrosoftHttp): DriveItemsResource {
  const items: DriveItemsResource = {
    async get(driveId, itemId, options) {
      return resource(
        await http.json(`${itemPath(driveId, itemId)}${query(options)}`, {
          signal: options?.signal,
        })
      )
    },
    async getByPath(driveId, path, options) {
      return resource(
        await http.json(`${drivePath(driveId)}/root:/${filePath(path)}${query(options)}`, {
          signal: options?.signal,
        })
      )
    },
    async listChildren(driveId, parentId = "root", options) {
      return page(
        await http.json(`${itemPath(driveId, parentId)}/children${query(options)}`, {
          signal: options?.signal,
        })
      )
    },
    listAllChildren(driveId, parentId = "root", options) {
      return allPages(http, `${itemPath(driveId, parentId)}/children${query(options)}`, options)
    },
    async download(driveId, itemId, options) {
      return new Uint8Array(
        await (await items.downloadResponse(driveId, itemId, options)).arrayBuffer()
      )
    },
    async downloadResponse(driveId, itemId, options) {
      let response = await http.request(`${itemPath(driveId, itemId)}/content`, {
        signal: options?.signal,
      })
      // Resolve redirects ourselves: the Graph bearer must never follow the download URL.
      for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects++) {
        const location = response.headers.get("location")
        await response.body?.cancel()
        if (!location || redirects >= 5)
          throw new MicrosoftProtocolError("Invalid or excessive download redirects.")
        response = await http.media(httpsUrl(location).href, { signal: options?.signal })
      }
      if (!response.ok) throw new MicrosoftApiError(response, await readResponseBody(response))
      return response
    },
    async preview(driveId, itemId, options) {
      const path = `${itemPath(driveId, itemId)}/preview`
      return previewInfo(
        await http.json(
          path,
          { method: "POST", body: previewBody(options), signal: options?.signal },
          { replayable: true }
        )
      )
    },
    async createFolder(driveId, parentId, name, options) {
      fileName(name)
      if (
        options?.conflictBehavior !== undefined &&
        options.conflictBehavior !== "fail" &&
        options.conflictBehavior !== "rename"
      ) {
        throw new MicrosoftConfigurationError("Folder conflictBehavior must be fail or rename.")
      }
      return resource(
        await http.json(`${itemPath(driveId, parentId)}/children`, {
          method: "POST",
          signal: options?.signal,
          body: {
            name,
            folder: {},
            "@microsoft.graph.conflictBehavior": conflict(options?.conflictBehavior, "fail"),
          },
        })
      )
    },
    async rename(driveId, itemId, name, options) {
      fileName(name)
      return resource(
        await http.json(itemPath(driveId, itemId), {
          method: "PATCH",
          body: { name },
          headers: writeHeaders(options),
          signal: options?.signal,
        })
      )
    },
    async move(driveId, itemId, parentId, options) {
      const path = itemPath(driveId, itemId)
      const headers = writeHeaders(options)
      itemPath(driveId, parentId)
      if (options?.name !== undefined) fileName(options.name)
      const id =
        parentId === "root"
          ? (await items.get(driveId, "root", { signal: options?.signal, select: ["id"] })).id
          : parentId
      return resource(
        await http.json(path, {
          method: "PATCH",
          body: {
            parentReference: { id },
            ...(options?.name !== undefined ? { name: options.name } : {}),
          },
          headers,
          signal: options?.signal,
        })
      )
    },
    async delete(driveId, itemId, options) {
      await checkEmpty(
        await http.request(itemPath(driveId, itemId), {
          method: "DELETE",
          headers: writeHeaders(options),
          signal: options?.signal,
        })
      )
    },
  }
  return items
}
