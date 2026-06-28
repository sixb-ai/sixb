import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import { listAllPages } from "../pagination"
import type { PandaDocLogEvent, PandaDocLogListOptions, PandaDocResultsResponse } from "../types"

export interface LogsVersionResource {
  /** `GET /public/v1/logs` or `GET /public/v2/logs` */
  list(options?: PandaDocLogListOptions): Promise<PandaDocResultsResponse<PandaDocLogEvent>>
  listAll(options?: PandaDocLogListOptions): AsyncIterable<PandaDocLogEvent>
  /** `GET /public/v1/logs/{id}` or `GET /public/v2/logs/{id}` */
  get(id: string): Promise<PandaDocLogEvent>
}

export interface LogsResource {
  readonly v1: LogsVersionResource
  readonly v2: LogsVersionResource
}

export function logsResource(http: PandaDocHttp): LogsResource {
  return {
    v1: logsVersionResource(http, "v1"),
    v2: logsVersionResource(http, "v2"),
  }
}

function logsVersionResource(http: PandaDocHttp, version: "v1" | "v2"): LogsVersionResource {
  const basePath = `public/${version}/logs`
  const resource: LogsVersionResource = {
    list(options) {
      return http.get(basePath, options)
    },
    listAll(options) {
      return listAllPages(resource.list, (page) => page.results, options)
    },
    get(id) {
      return http.get(`${basePath}/${pathPart(id, "log id")}`)
    },
  }

  return resource
}
