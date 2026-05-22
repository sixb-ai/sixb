import {
  type Client,
  createClient,
  type GetDatasetResponse,
  type GetDatasetVersionResponse,
  type GetObjectResponse,
  type GetObjectTypeResponse,
  type GetStatusResponse,
  type GetSyncResponse,
  getDataset,
  getDatasetVersion,
  getObject,
  getObjectType,
  getStatus,
  getSync,
  type ListDatasetsResponse,
  type ListDatasetVersionsResponse,
  type ListObjectLinksResponse,
  type ListObjectsResponse,
  type ListObjectTypesResponse,
  type ListSyncRunsResponse,
  type ListSyncsResponse,
  listDatasets,
  listDatasetVersions,
  listObjectLinks,
  listObjects,
  listObjectTypes,
  listSyncRuns,
  listSyncs,
  type RequestActionResponse,
  requestAction,
} from "@pario/client"
import {
  DATASET_VERSION_MAX,
  OBJECT_LIST_ORDER,
  OBJECT_LIST_ORDER_BY,
  PAGE_SIZE,
  SYNC_RUN_LIST_ORDER,
} from "./constants"
import type { CreateParioRemoteS4ProviderOptions } from "./types"

interface SdkEnvelope<T> {
  readonly data?: T
  readonly error?: unknown
  readonly request?: Request
  readonly response?: Response
}

type SdkCall<T> = (options: { readonly client: Client }) => Promise<SdkEnvelope<T>>

export type ParioS4Api = ReturnType<typeof createParioS4Api>

export function createParioS4Api(options: CreateParioRemoteS4ProviderOptions) {
  const client = createClient({
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    fetch: options.fetch as typeof fetch | undefined,
    headers: options.headers,
    responseStyle: "fields",
  })

  async function request<T>(call: SdkCall<T>): Promise<T> {
    const result = await call({ client })
    if (result.response?.ok && result.data !== undefined) {
      return result.data
    }
    throw sdkError(result)
  }

  async function requestOrNull<T>(call: SdkCall<T>): Promise<T | null> {
    const result = await call({ client })
    if (result.response?.status === 404) {
      return null
    }
    if (result.response?.ok && result.data !== undefined) {
      return result.data
    }
    throw sdkError(result)
  }

  async function listObjectsAll(objectTypeId: string): Promise<ListObjectsResponse> {
    const objects: ListObjectsResponse["objects"] = []
    let offset = 0
    while (true) {
      const page = await request<ListObjectsResponse>((opts) =>
        listObjects({
          ...opts,
          query: {
            objectTypeId,
            limit: String(PAGE_SIZE),
            offset: String(offset),
            orderBy: OBJECT_LIST_ORDER_BY,
            order: OBJECT_LIST_ORDER,
          },
        })
      )
      objects.push(...page.objects)
      if (!page.hasMore || page.objects.length === 0) {
        return { objects, hasMore: false, total: objects.length }
      }
      offset += page.objects.length
    }
  }

  async function listSyncRunsAll(syncId: string): Promise<ListSyncRunsResponse> {
    const runs: ListSyncRunsResponse["runs"] = []
    let offset = 0
    while (true) {
      const page = await request<ListSyncRunsResponse>((opts) =>
        listSyncRuns({
          ...opts,
          query: {
            syncId,
            limit: String(PAGE_SIZE),
            offset: String(offset),
            order: SYNC_RUN_LIST_ORDER,
          },
        })
      )
      runs.push(...page.runs)
      if (!page.hasMore || page.runs.length === 0) {
        return { runs, hasMore: false, total: runs.length }
      }
      offset += page.runs.length
    }
  }

  return {
    status: () => request<GetStatusResponse>((opts) => getStatus(opts)),

    listObjectTypes: () => request<ListObjectTypesResponse>((opts) => listObjectTypes(opts)),

    getObjectType: (objectTypeId: string) =>
      requestOrNull<GetObjectTypeResponse>((opts) =>
        getObjectType({ ...opts, path: { objectTypeId } })
      ),

    listObjects: listObjectsAll,

    getObject: (objectTypeId: string, primaryId: string) =>
      requestOrNull<GetObjectResponse>((opts) =>
        getObject({ ...opts, path: { objectTypeId, objectId: primaryId } })
      ),

    listLinks: (objectTypeId: string, primaryId: string) =>
      request<ListObjectLinksResponse>((opts) =>
        listObjectLinks({ ...opts, path: { objectTypeId, objectId: primaryId } })
      ),

    requestAction: (
      objectTypeId: string,
      primaryId: string,
      actionId: string,
      params: Record<string, unknown>
    ) =>
      request<RequestActionResponse>((opts) =>
        requestAction({
          ...opts,
          path: { objectTypeId, objectId: primaryId, actionId },
          body: { params },
        })
      ),

    listDatasets: () => request<ListDatasetsResponse>((opts) => listDatasets(opts)),

    getDataset: (datasetId: string) =>
      requestOrNull<GetDatasetResponse>((opts) => getDataset({ ...opts, path: { datasetId } })),

    listDatasetVersions: (datasetId: string) =>
      request<ListDatasetVersionsResponse>((opts) =>
        listDatasetVersions({
          ...opts,
          path: { datasetId },
          query: { limit: String(DATASET_VERSION_MAX) },
        })
      ),

    getDatasetVersion: (datasetId: string, versionId: string) =>
      requestOrNull<GetDatasetVersionResponse>((opts) =>
        getDatasetVersion({ ...opts, path: { datasetId, versionId } })
      ),

    listSyncs: () => request<ListSyncsResponse>((opts) => listSyncs(opts)),

    getSync: (syncId: string) =>
      requestOrNull<GetSyncResponse>((opts) => getSync({ ...opts, path: { syncId } })),

    listSyncRuns: listSyncRunsAll,
  }
}

function sdkError(result: SdkEnvelope<unknown>): Error {
  const requestLabel = result.request?.url ?? "request"
  if (!result.response) {
    return new Error(`[ParioS4] Network error for ${requestLabel}: ${formatError(result.error)}`)
  }
  return new Error(
    `[ParioS4] HTTP ${result.response.status} ${result.response.statusText} for ${requestLabel}: ${formatError(result.error)}`
  )
}

function formatError(error: unknown): string {
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error, null, 2)
  } catch {
    return String(error)
  }
}
