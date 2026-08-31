import {
  type QueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { useSixbProviderClient } from "../client-provider"
import {
  getConnectorConnectionRunQueryKey,
  listConnectorConnectionsQueryKey,
} from "../generated/@tanstack/react-query.gen"
import type { Client } from "../generated/client"
import {
  addConnectorConnection,
  disconnectConnectorConnection,
  reauthorizeConnectorConnection,
  revokeConnectorConnection,
  selectConnectorConnectionRunAccount,
  startConnectorConnectionRun,
} from "../generated/sdk.gen"
import type {
  AddConnectorConnectionResponse,
  DisconnectConnectorConnectionResponse,
  ReauthorizeConnectorConnectionResponse,
  RevokeConnectorConnectionResponse,
  SelectConnectorConnectionRunAccountResponse,
  StartConnectorConnectionRunResponse,
} from "../generated/types.gen"

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
  const normalizedConnectorId = nonblank(connectorId, "connectorId")
  const path = () => ({
    connectorId: normalizedConnectorId,
    runId: nonblank(runId, "runId"),
  })

  return {
    ...mutationOptions,
    mutationFn: async ({ accountId, replace }) => {
      const resolvedPath = path()
      const { data } = await selectConnectorConnectionRunAccount<true>({
        client,
        path: resolvedPath,
        body: {
          accountId: nonblank(accountId, "accountId"),
          ...(replace === undefined ? {} : { replace }),
        },
        throwOnError: true,
      })
      return data
    },
    onSuccess: async (run, variables, context, mutation) => {
      const resolvedPath = path()
      queryClient?.setQueryData(getConnectorConnectionRunQueryKey({ path: resolvedPath }), run)
      await invalidateConnectorConnections(queryClient, resolvedPath.connectorId)
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

interface ConnectorConnectionMutationOptions<TResponse, TContext>
  extends Omit<UseMutationOptions<TResponse, Error, void, TContext>, "mutationFn"> {
  readonly connectorId: string
  readonly connectionId: string
  /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
  readonly client?: Client
  /** Override used by tests and non-hook option factory consumers. */
  readonly queryClient?: QueryClient
}

export type DisconnectConnectorOptions<TContext = unknown> = ConnectorConnectionMutationOptions<
  DisconnectConnectorConnectionResponse,
  TContext
>

export function disconnectConnectorMutationOptions<TContext = unknown>(
  options: DisconnectConnectorOptions<TContext>
): UseMutationOptions<DisconnectConnectorConnectionResponse, Error, void, TContext> {
  const { connectorId, connectionId, client, queryClient, onSuccess, ...mutationOptions } = options
  const normalizedConnectorId = nonblank(connectorId, "connectorId")
  const path = () => ({
    connectorId: normalizedConnectorId,
    connectionId: nonblank(connectionId, "connectionId"),
  })

  return {
    ...mutationOptions,
    mutationFn: async () => {
      const resolvedPath = path()
      const { data } = await disconnectConnectorConnection<true>({
        client,
        path: resolvedPath,
        throwOnError: true,
      })
      return data
    },
    onSuccess: async (result, variables, context, mutation) => {
      await invalidateConnectorConnections(queryClient, normalizedConnectorId)
      await onSuccess?.(result, variables, context, mutation)
    },
  }
}

export function useDisconnectConnector<TContext = unknown>(
  options: DisconnectConnectorOptions<TContext>
): UseMutationResult<DisconnectConnectorConnectionResponse, Error, void, TContext> {
  const providerClient = useSixbProviderClient()
  const queryClient = useQueryClient()
  return useMutation(
    disconnectConnectorMutationOptions({
      ...options,
      client: options.client ?? providerClient,
      queryClient: options.queryClient ?? queryClient,
    })
  )
}

export type RevokeConnectorOptions<TContext = unknown> = ConnectorConnectionMutationOptions<
  RevokeConnectorConnectionResponse,
  TContext
>

export function revokeConnectorMutationOptions<TContext = unknown>(
  options: RevokeConnectorOptions<TContext>
): UseMutationOptions<RevokeConnectorConnectionResponse, Error, void, TContext> {
  const { connectorId, connectionId, client, queryClient, onSuccess, ...mutationOptions } = options
  const normalizedConnectorId = nonblank(connectorId, "connectorId")
  const path = () => ({
    connectorId: normalizedConnectorId,
    connectionId: nonblank(connectionId, "connectionId"),
  })

  return {
    ...mutationOptions,
    mutationFn: async () => {
      const resolvedPath = path()
      const { data } = await revokeConnectorConnection<true>({
        client,
        path: resolvedPath,
        throwOnError: true,
      })
      return data
    },
    onSuccess: async (result, variables, context, mutation) => {
      await invalidateConnectorConnections(queryClient, normalizedConnectorId)
      await onSuccess?.(result, variables, context, mutation)
    },
  }
}

export function useRevokeConnector<TContext = unknown>(
  options: RevokeConnectorOptions<TContext>
): UseMutationResult<RevokeConnectorConnectionResponse, Error, void, TContext> {
  const providerClient = useSixbProviderClient()
  const queryClient = useQueryClient()
  return useMutation(
    revokeConnectorMutationOptions({
      ...options,
      client: options.client ?? providerClient,
      queryClient: options.queryClient ?? queryClient,
    })
  )
}

export interface ReauthorizeConnectorOptions<TContext = unknown>
  extends Omit<
    UseMutationOptions<ReauthorizeConnectorConnectionResponse, Error, void, TContext>,
    "mutationFn"
  > {
  readonly connectorId: string
  readonly connectionId: string
  readonly returnTo: string
  /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
  readonly client?: Client
}

export function reauthorizeConnectorMutationOptions<TContext = unknown>(
  options: ReauthorizeConnectorOptions<TContext>
): UseMutationOptions<ReauthorizeConnectorConnectionResponse, Error, void, TContext> {
  const { connectorId, connectionId, returnTo, client, ...mutationOptions } = options
  const normalizedConnectorId = nonblank(connectorId, "connectorId")

  return {
    ...mutationOptions,
    mutationFn: async () => {
      const { data } = await reauthorizeConnectorConnection<true>({
        client,
        path: {
          connectorId: normalizedConnectorId,
          connectionId: nonblank(connectionId, "connectionId"),
        },
        body: { returnTo: resolveReturnTo(returnTo) },
        throwOnError: true,
      })
      return data
    },
  }
}

export function useReauthorizeConnector<TContext = unknown>(
  options: ReauthorizeConnectorOptions<TContext>
): UseMutationResult<ReauthorizeConnectorConnectionResponse, Error, void, TContext> {
  const providerClient = useSixbProviderClient()
  return useMutation(
    reauthorizeConnectorMutationOptions({
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

async function invalidateConnectorConnections(
  queryClient: QueryClient | undefined,
  connectorId: string
): Promise<void> {
  if (!queryClient) return
  await queryClient.invalidateQueries({
    queryKey: listConnectorConnectionsQueryKey({ path: { connectorId } }),
  })
}
