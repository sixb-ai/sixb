import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import { allPages, page } from "../../pagination"
import type { GraphPage, ListOptions, SelectOptions } from "../../types/common"
import type { Drive, Site } from "../../types/files"
import { filePath, httpsUrl, query, resource, segment } from "../../validation"

export interface SitesResource {
  get(siteId: string, options?: SelectOptions): Promise<Site>
  /** Site URL (not a document library URL or a sharing link). */
  getByUrl(siteUrl: string, options?: SelectOptions): Promise<Site>
  listDrives(siteId: string, options?: ListOptions): Promise<GraphPage<Drive>>
  listAllDrives(siteId: string, options?: ListOptions): AsyncIterable<Drive>
}

export function sitesResource(http: MicrosoftHttp): SitesResource {
  return {
    async get(siteId, options) {
      return resource(
        await http.json(`sites/${segment(siteId)}${query(options)}`, { signal: options?.signal })
      )
    },
    async getByUrl(siteUrl, options) {
      const url = httpsUrl(siteUrl)
      if (url.search || !url.hostname.endsWith(".sharepoint.com")) {
        throw new MicrosoftConfigurationError(
          "siteUrl must be a SharePoint Online site URL without query parameters."
        )
      }
      let decoded: string
      try {
        decoded = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ""))
      } catch {
        throw new MicrosoftConfigurationError("siteUrl contains invalid URL encoding.")
      }
      const path = decoded
        ? `sites/${segment(url.hostname)}:/${filePath(decoded)}`
        : `sites/${segment(url.hostname)}`
      return resource(await http.json(`${path}${query(options)}`, { signal: options?.signal }))
    },
    async listDrives(siteId, options) {
      return page(
        await http.json(`sites/${segment(siteId)}/drives${query(options)}`, {
          signal: options?.signal,
        })
      )
    },
    listAllDrives(siteId, options) {
      return allPages(http, `sites/${segment(siteId)}/drives${query(options)}`, options)
    },
  }
}
