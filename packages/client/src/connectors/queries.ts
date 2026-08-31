import {
  queryOptions,
  type UseQueryOptions,
  type UseQueryResult,
  useQuery,
} from "@tanstack/react-query"
import { useSixbProviderClient } from "../client-provider"
import {
  getConnectorConnectionRunQueryKey,
  listConnectorConnectionsQueryKey,
} from "../generated/@tanstack/react-query.gen"
import type { Client } from "../generated/client"
import { getConnectorConnectionRun, listConnectorConnections } from "../generated/sdk.gen"
import type {
  GetConnectorConnectionRunResponse,
  ListConnectorConnectionsResponse,
} from "../generated/types.gen"

export type ConnectorConnection = ListConnectorConnectionsResponse[number]
export type ConnectorAccount = ConnectorConnection["account"]
export type ConnectorConnectionRun = GetConnectorConnectionRunResponse

export type ConnectorConnectionsQueryKey = ReturnType<typeof listConnectorConnectionsQueryKey>

export interface ConnectorConnectionsOptions
  extends Omit<
    UseQueryOptions<
      ListConnectorConnectionsResponse,
      Error,
      ListConnectorConnectionsResponse,
      ConnectorConnectionsQueryKey
    >,
    "queryKey" | "queryFn"
  > {
  readonly connectorId: string
  /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
  readonly client?: Client
}

export function connectorConnectionsQueryOptions(options: ConnectorConnectionsOptions) {
  const { connectorId, client, ...queryOptionsInput } = options
  const path = { connectorId: nonblank(connectorId, "connectorId") }

  return queryOptions<
    ListConnectorConnectionsResponse,
    Error,
    ListConnectorConnectionsResponse,
    ConnectorConnectionsQueryKey
  >({
    ...queryOptionsInput,
    queryKey: listConnectorConnectionsQueryKey({ path }),
    queryFn: async ({ signal }) => {
      const { data } = await listConnectorConnections<true>({
        client,
        path,
        signal,
        throwOnError: true,
      })
      return data
    },
  })
}

export function useConnectorConnections(
  options: ConnectorConnectionsOptions
): UseQueryResult<ListConnectorConnectionsResponse, Error> {
  const providerClient = useSixbProviderClient()
  return useQuery(
    connectorConnectionsQueryOptions({
      ...options,
      client: options.client ?? providerClient,
    })
  )
}

export type ConnectorConnectionRunQueryKey = ReturnType<typeof getConnectorConnectionRunQueryKey>

export interface ConnectorConnectionRunOptions
  extends Omit<
    UseQueryOptions<
      GetConnectorConnectionRunResponse,
      Error,
      GetConnectorConnectionRunResponse,
      ConnectorConnectionRunQueryKey
    >,
    "queryKey" | "queryFn"
  > {
  readonly connectorId: string
  /** A missing callback query parameter disables the query. */
  readonly runId: string | null | undefined
  /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
  readonly client?: Client
}

export function connectorConnectionRunQueryOptions(options: ConnectorConnectionRunOptions) {
  const { connectorId, runId, client, ...queryOptionsInput } = options
  const normalizedRunId = optionalNonblank(runId, "runId")
  const path = {
    connectorId: nonblank(connectorId, "connectorId"),
    runId: normalizedRunId ?? "",
  }

  return queryOptions<
    GetConnectorConnectionRunResponse,
    Error,
    GetConnectorConnectionRunResponse,
    ConnectorConnectionRunQueryKey
  >({
    ...queryOptionsInput,
    enabled: normalizedRunId === undefined ? false : queryOptionsInput.enabled,
    queryKey: getConnectorConnectionRunQueryKey({ path }),
    queryFn: async ({ signal }) => {
      if (normalizedRunId === undefined) {
        throw new Error("[SixbClient] runId is required to read a connector connection run.")
      }
      const { data } = await getConnectorConnectionRun<true>({
        client,
        path,
        signal,
        throwOnError: true,
      })
      return data
    },
  })
}

export function useConnectorConnectionRun(
  options: ConnectorConnectionRunOptions
): UseQueryResult<GetConnectorConnectionRunResponse, Error> {
  const providerClient = useSixbProviderClient()
  return useQuery(
    connectorConnectionRunQueryOptions({
      ...options,
      client: options.client ?? providerClient,
    })
  )
}

function nonblank(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[SixbClient] ${field} must be a non-empty string.`)
  }
  return normalized
}

function optionalNonblank(value: string | null | undefined, field: string): string | undefined {
  if (value === null || value === undefined) return undefined
  return nonblank(value, field)
}
