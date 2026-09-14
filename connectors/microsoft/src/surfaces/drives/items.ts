import { readResponseBody } from "@sixb/connector-rest"
import {
  MicrosoftApiError,
  MicrosoftConfigurationError,
  MicrosoftProtocolError,
} from "../../errors"
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
import type { DriveItem } from "../../types/files"
import { fileName, filePath, httpsUrl, nonEmpty, query, resource } from "../../validation"
import { drivePath, itemPath } from "./paths"

export interface CreateFolderOptions extends RequestOptions {
  readonly conflictBehavior?: "fail" | "rename"
}

export interface MoveOptions extends WriteOptions {
  readonly name?: string
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
