import {
  type QueryClient,
  queryOptions,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useSixbProviderClient } from "./client-provider"
import {
  getConnectorConnectionRunQueryKey,
  listConnectorConnectionsQueryKey,
} from "./generated/@tanstack/react-query.gen"
import type { Client } from "./generated/client"
import {
  addConnectorConnection,
  getConnectorConnectionRun,
  selectConnectorConnectionRunAccount,
  startConnectorConnectionRun,
} from "./generated/sdk.gen"
import type {
  AddConnectorConnectionResponse,
  GetConnectorConnectionRunResponse,
  SelectConnectorConnectionRunAccountResponse,
  StartConnectorConnectionRunResponse,
} from "./generated/types.gen"

export interface AddConnectorConnectionOptions<TContext = unknown>
  extends Omit<
    UseMutationOptions<AddConnectorConnectionResponse, Error, void, TContext>,
    "mutationFn"
  > {
  readonly connectorId: string
  readonly fromConnectionId: string
  readonly slot: string
  /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
  readonly client?: Client
  /** Override used by tests and non-hook option factory consumers. */
  readonly queryClient?: QueryClient
}

export function addConnectorConnectionMutationOptions<TContext = unknown>(
  options: AddConnectorConnectionOptions<TContext>
): UseMutationOptions<AddConnectorConnectionResponse, Error, void, TContext> {
  const {
    connectorId,
    fromConnectionId,
    slot,
    client,
    queryClient,
    onSuccess,
    ...mutationOptions
  } = options
  const normalizedConnectorId = nonblank(connectorId, "connectorId")
  const path = {
    connectorId: normalizedConnectorId,
    connectionId: nonblank(fromConnectionId, "fromConnectionId"),
  }

  return {
    ...mutationOptions,
    mutationFn: async () => {
      const { data } = await addConnectorConnection<true>({
        client,
        path,
        body: { slot: nonblank(slot, "slot") },
        throwOnError: true,
      })
      return data
    },
    onSuccess: async (run, variables, context, mutation) => {
      queryClient?.setQueryData(
        getConnectorConnectionRunQueryKey({
          path: { connectorId: normalizedConnectorId, runId: run.id },
        }),
        run
      )
      await onSuccess?.(run, variables, context, mutation)
    },
  }
}

export function useAddConnectorConnection<TContext = unknown>(
  options: AddConnectorConnectionOptions<TContext>
): UseMutationResult<AddConnectorConnectionResponse, Error, void, TContext> {
  const providerClient = useSixbProviderClient()
  const queryClient = useQueryClient()
  return useMutation(
    addConnectorConnectionMutationOptions({
      ...options,
      client: options.client ?? providerClient,
      queryClient: options.queryClient ?? queryClient,
    })
  )
}

export interface ConnectConnectorOptions<TContext = unknown>
  extends Omit<
    UseMutationOptions<StartConnectorConnectionRunResponse, Error, void, TContext>,
    "mutationFn"
  > {
  readonly connectorId: string
  readonly slot: string
  readonly returnTo: string
  /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
  readonly client?: Client
}

export function connectConnectorMutationOptions<TContext = unknown>(
  options: ConnectConnectorOptions<TContext>
): UseMutationOptions<StartConnectorConnectionRunResponse, Error, void, TContext> {
  const { connectorId, slot, returnTo, client, ...mutationOptions } = options
  const normalizedConnectorId = nonblank(connectorId, "connectorId")
  const normalizedSlot = nonblank(slot, "slot")

  return {
    ...mutationOptions,
    mutationFn: async () => {
      const { data } = await startConnectorConnectionRun<true>({
        client,
        path: { connectorId: normalizedConnectorId },
        body: {
          slot: normalizedSlot,
          returnTo: resolveReturnTo(returnTo),
        },
        throwOnError: true,
      })
      return data
    },
  }
}

export function useConnectConnector<TContext = unknown>(
  options: ConnectConnectorOptions<TContext>
): UseMutationResult<StartConnectorConnectionRunResponse, Error, void, TContext> {
  const providerClient = useSixbProviderClient()
  return useMutation(
    connectConnectorMutationOptions({
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
  const queryKey = getConnectorConnectionRunQueryKey({ path })

  return queryOptions<
    GetConnectorConnectionRunResponse,
    Error,
    GetConnectorConnectionRunResponse,
    ConnectorConnectionRunQueryKey
  >({
    ...queryOptionsInput,
    enabled: normalizedRunId === undefined ? false : queryOptionsInput.enabled,
    queryKey,
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

export interface SelectConnectorAccountInput {
  readonly accountId: string
  readonly replace?: boolean
}

export interface SelectConnectorAccountOptions<TContext = unknown>
  extends Omit<
    UseMutationOptions<
      SelectConnectorConnectionRunAccountResponse,
      Error,
      SelectConnectorAccountInput,
      TContext
    >,
    "mutationFn"
  > {
  readonly connectorId: string
  readonly runId: string
  /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
  readonly client?: Client
  /** Override used by tests and non-hook option factory consumers. */
  readonly queryClient?: QueryClient
}

export function selectConnectorAccountMutationOptions<TContext = unknown>(
  options: SelectConnectorAccountOptions<TContext>
): UseMutationOptions<
  SelectConnectorConnectionRunAccountResponse,
  Error,
  SelectConnectorAccountInput,
  TContext
> {
  const { connectorId, runId, client, queryClient, onSuccess, ...mutationOptions } = options
  const path = {
    connectorId: nonblank(connectorId, "connectorId"),
    runId: nonblank(runId, "runId"),
  }

  return {
    ...mutationOptions,
    mutationFn: async ({ accountId, replace }) => {
      const { data } = await selectConnectorConnectionRunAccount<true>({
        client,
        path,
        body: {
          accountId: nonblank(accountId, "accountId"),
          ...(replace === undefined ? {} : { replace }),
        },
        throwOnError: true,
      })
      return data
    },
    onSuccess: async (run, variables, context, mutation) => {
      if (queryClient) {
        queryClient.setQueryData(getConnectorConnectionRunQueryKey({ path }), run)
        await queryClient.invalidateQueries({
          queryKey: listConnectorConnectionsQueryKey({
            path: { connectorId: path.connectorId },
          }),
        })
      }
      await onSuccess?.(run, variables, context, mutation)
    },
  }
}

export function useSelectConnectorAccount<TContext = unknown>(
  options: SelectConnectorAccountOptions<TContext>
): UseMutationResult<
  SelectConnectorConnectionRunAccountResponse,
  Error,
  SelectConnectorAccountInput,
  TContext
> {
  const providerClient = useSixbProviderClient()
  const queryClient = useQueryClient()
  return useMutation(
    selectConnectorAccountMutationOptions({
      ...options,
      client: options.client ?? providerClient,
      queryClient: options.queryClient ?? queryClient,
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

function resolveReturnTo(value: string): string {
  const returnTo = nonblank(value, "returnTo")

  try {
    return new URL(returnTo).toString()
  } catch {
    const currentUrl = globalThis.location?.href
    if (!currentUrl) {
      throw new Error(
        "[SixbClient] A relative connector returnTo can only be resolved in a browser."
      )
    }

    try {
      return new URL(returnTo, currentUrl).toString()
    } catch (error) {
      throw new Error("[SixbClient] Connector returnTo must be a valid URL.", { cause: error })
    }
  }
}
