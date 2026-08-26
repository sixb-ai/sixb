import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isSixbApiError } from "../api"
import {
  useConnectConnector,
  useDisconnectConnector,
  useReauthorizeConnector,
  useRevokeConnector,
  useSelectConnectorAccount,
} from "./mutations"
import {
  type ConnectorAccount,
  type ConnectorConnection,
  type ConnectorConnectionRun,
  useConnectorConnectionRun,
  useConnectorConnections,
} from "./queries"

const CONNECTOR_CALLBACK_CONNECTOR_PARAM = "connectionConnectorId"
const CONNECTOR_CALLBACK_RUN_PARAM = "connectionRunId"
const RUN_POLL_INTERVAL_MS = 1_000

interface ConnectorConnectionCallback {
  readonly connectorId: string
  readonly runId: string
}

export interface UseConnectorConnectionOptions {
  readonly connectorId: string
  /** Stable application-defined role filled by this connection, for example `organic` or `ads`. */
  readonly slot: string
  /** Defaults to the current page while preserving unrelated query parameters and the hash. */
  readonly returnTo?: string
}

export type ConnectorConnectionStatus =
  | "loading"
  | "disconnected"
  | "authorizing"
  | "selecting_account"
  | "connected"
  | "needs_reauthorization"
  | "error"

export type ConnectorConnectionOperation =
  | "load"
  | "resume"
  | "connect"
  | "select_account"
  | "disconnect"
  | "revoke"

export interface ConnectorConnectionFailure {
  readonly operation: ConnectorConnectionOperation
  readonly cause: unknown
}

export interface ConnectorAccountSelectionOptions {
  readonly replace?: boolean
}

export interface UseConnectorConnectionResult {
  readonly status: ConnectorConnectionStatus
  readonly connection: ConnectorConnection | undefined
  readonly accounts: readonly ConnectorAccount[]
  readonly error: ConnectorConnectionFailure | null
  /** Whether a new authorization or reauthorization can start from the current state. */
  readonly canConnect: boolean
  readonly isPending: boolean
  readonly selectedAccountId: string | undefined
  connect(): Promise<void>
  selectAccount(accountId: string, options?: ConnectorAccountSelectionOptions): Promise<void>
  disconnect(): Promise<void>
  revoke(): Promise<void>
  refresh(): Promise<void>
  dismiss(): void
  resetError(): void
}

/**
 * Headless OAuth connection flow for one application-defined connector slot.
 *
 * The hook owns browser redirection, durable run resumption and cache convergence. The application
 * owns presentation, including account selection and replacement confirmation.
 */
export function useConnectorConnection({
  connectorId,
  slot,
  returnTo,
}: UseConnectorConnectionOptions): UseConnectorConnectionResult {
  const [callback, setCallback] = useState(readConnectorConnectionCallback)
  const connectInFlightRef = useRef<Promise<void> | null>(null)
  const callbackRunId = callback?.connectorId === connectorId ? callback.runId : null
  const connectionsQuery = useConnectorConnections({ connectorId })
  const connection = useMemo(
    () => connectionsQuery.data?.find((candidate) => candidate.slot === slot),
    [connectionsQuery.data, slot]
  )
  const runQuery = useConnectorConnectionRun({
    connectorId,
    runId: callbackRunId,
    refetchInterval: (query) => (isRunInProgress(query.state.data) ? RUN_POLL_INTERVAL_MS : false),
  })
  const resumedRun = runQuery.data?.slot === slot ? runQuery.data : undefined
  const resolvedReturnTo = returnTo ?? connectorConnectionReturnTo()

  const connectMutation = useConnectConnector({ connectorId, slot, returnTo: resolvedReturnTo })
  const reauthorizeMutation = useReauthorizeConnector({
    connectorId,
    connectionId: connection?.id ?? "",
    returnTo: resolvedReturnTo,
  })
  const selectMutation = useSelectConnectorAccount({
    connectorId,
    runId: resumedRun?.id ?? "",
  })
  const disconnectMutation = useDisconnectConnector({
    connectorId,
    connectionId: connection?.id ?? "",
  })
  const revokeMutation = useRevokeConnector({
    connectorId,
    connectionId: connection?.id ?? "",
  })

  const refreshConnectionsAndConsumeCallback = useCallback(
    async (
      expectedCallback?: ConnectorConnectionCallback,
      canConsume: () => boolean = () => true
    ): Promise<void> => {
      const result = await connectionsQuery.refetch()
      if (result.error || !expectedCallback || !canConsume()) return
      if (!result.data?.some((candidate) => candidate.slot === slot)) return

      clearConnectorConnectionCallback(expectedCallback)
      setCallback((current) =>
        sameConnectorConnectionCallback(current, expectedCallback) ? null : current
      )
    },
    [connectionsQuery.refetch, slot]
  )

  const completedRunId = resumedRun?.status === "succeeded" ? resumedRun.id : null
  useEffect(() => {
    if (!completedRunId || !callback) return
    let active = true

    void refreshConnectionsAndConsumeCallback(callback, () => active)

    return () => {
      active = false
    }
  }, [callback, completedRunId, refreshConnectionsAndConsumeCallback])

  function connect(): Promise<void> {
    if (connectInFlightRef.current) return connectInFlightRef.current
    if (!canConnect) return Promise.resolve()

    resetError()
    const operation = (async () => {
      const started =
        resumedRun?.kind === "reauthorize" || connection?.status === "needs_reauthorization"
          ? await reauthorizeMutation.mutateAsync()
          : await connectMutation.mutateAsync()
      redirectToAuthorization(started.authorizationUrl)
    })()
    connectInFlightRef.current = operation
    operation.then(clearConnectInFlight, clearConnectInFlight)
    return operation

    function clearConnectInFlight(): void {
      if (connectInFlightRef.current === operation) connectInFlightRef.current = null
    }
  }

  async function selectAccount(
    accountId: string,
    options: ConnectorAccountSelectionOptions = {}
  ): Promise<void> {
    if (resumedRun?.status !== "waiting" || resumedRun.waitingFor !== "account_selection") {
      throw new Error("[SixbClient] No connector account selection is currently pending.")
    }
    await selectMutation.mutateAsync({ accountId, replace: options.replace })
  }

  async function disconnect(): Promise<void> {
    if (!connection) {
      throw new Error("[SixbClient] Connector connection is unavailable.")
    }
    await disconnectMutation.mutateAsync()
  }

  async function revoke(): Promise<void> {
    if (!connection) {
      throw new Error("[SixbClient] Connector connection is unavailable.")
    }
    await revokeMutation.mutateAsync()
  }

  async function refresh(): Promise<void> {
    let completedCallback: ConnectorConnectionCallback | undefined
    if (callbackRunId !== null) {
      const runResult = await runQuery.refetch()
      if (
        !runResult.error &&
        runResult.data?.slot === slot &&
        runResult.data.status === "succeeded" &&
        sameConnectorConnectionCallback(callback, {
          connectorId,
          runId: runResult.data.id,
        })
      ) {
        completedCallback = callback ?? undefined
      }
    }
    await refreshConnectionsAndConsumeCallback(completedCallback)
  }

  function dismiss(): void {
    if (!callback) return
    clearConnectorConnectionCallback(callback)
    setCallback(null)
    resetError()
  }

  function resetError(): void {
    connectMutation.reset()
    reauthorizeMutation.reset()
    selectMutation.reset()
    disconnectMutation.reset()
    revokeMutation.reset()
  }

  const status = connectionStatus({
    callbackRunId,
    connectionsPending: connectionsQuery.isPending,
    connectionsError: connectionsQuery.error,
    runPending: runQuery.isPending,
    runError: runQuery.error,
    run: resumedRun,
    connection,
  })
  const mutationPending =
    connectMutation.isPending ||
    reauthorizeMutation.isPending ||
    selectMutation.isPending ||
    disconnectMutation.isPending ||
    revokeMutation.isPending
  const canConnect = connectorCanConnect({
    status,
    connectionsError: connectionsQuery.error,
    runError: runQuery.error,
    run: resumedRun,
    connection,
    mutationPending,
  })

  return {
    status,
    connection,
    accounts: accountSelection(resumedRun),
    error:
      mutationFailure("connect", connectMutation.error) ??
      mutationFailure("connect", reauthorizeMutation.error) ??
      mutationFailure("select_account", selectMutation.error) ??
      mutationFailure("disconnect", disconnectMutation.error) ??
      mutationFailure("revoke", revokeMutation.error) ??
      runFailure(callbackRunId, resumedRun, runQuery.error) ??
      mutationFailure("load", connectionsQuery.error),
    canConnect,
    isPending: status === "loading" || status === "authorizing" || mutationPending,
    selectedAccountId: selectMutation.variables?.accountId,
    connect,
    selectAccount,
    disconnect,
    revoke,
    refresh,
    dismiss,
    resetError,
  }
}

export function isConnectorReplacementRequired(error: unknown): boolean {
  if (isSixbApiError(error)) return error.code === "connector.replacement_required"
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "connector.replacement_required"
  )
}

function connectorCanConnect(input: {
  readonly status: ConnectorConnectionStatus
  readonly connectionsError: Error | null
  readonly runError: Error | null
  readonly run: ConnectorConnectionRun | undefined
  readonly connection: ConnectorConnection | undefined
  readonly mutationPending: boolean
}): boolean {
  if (input.mutationPending || input.connectionsError || input.runError) return false
  if (input.status === "disconnected" || input.status === "needs_reauthorization") return true
  const run = input.run
  if (input.status !== "error" || !run || !isRunTerminal(run)) return false
  if (run.kind === "reauthorize") return input.connection !== undefined
  return input.connection?.status !== "connected"
}

function connectionStatus(input: {
  readonly callbackRunId: string | null
  readonly connectionsPending: boolean
  readonly connectionsError: Error | null
  readonly runPending: boolean
  readonly runError: Error | null
  readonly run: ConnectorConnectionRun | undefined
  readonly connection: ConnectorConnection | undefined
}): ConnectorConnectionStatus {
  const { run } = input
  if (run?.status === "waiting" && run.waitingFor === "account_selection") {
    return "selecting_account"
  }
  if (input.callbackRunId !== null) {
    if (
      input.runError ||
      run?.status === "failed" ||
      run?.status === "cancelled" ||
      run?.status === "expired"
    ) {
      return "error"
    }
    if (
      input.runPending ||
      run?.status === "waiting" ||
      run?.status === "running" ||
      run?.status === "succeeded"
    ) {
      return "authorizing"
    }
  }
  if (input.connectionsError) return "error"
  if (input.connectionsPending) return "loading"
  if (input.connection?.status === "connected") return "connected"
  if (input.connection?.status === "needs_reauthorization") return "needs_reauthorization"
  return "disconnected"
}

function accountSelection(run: ConnectorConnectionRun | undefined): readonly ConnectorAccount[] {
  if (run?.status !== "waiting" || run.waitingFor !== "account_selection") return []
  return run.accounts
}

function mutationFailure(
  operation: ConnectorConnectionOperation,
  cause: unknown
): ConnectorConnectionFailure | null {
  return cause ? { operation, cause } : null
}

function runFailure(
  callbackRunId: string | null,
  run: ConnectorConnectionRun | undefined,
  queryError: Error | null
): ConnectorConnectionFailure | null {
  if (callbackRunId === null) return null
  if (queryError) return { operation: "resume", cause: queryError }
  if (run?.status === "failed") return { operation: "resume", cause: run.error }
  if (run?.status === "cancelled") {
    return {
      operation: "resume",
      cause: new Error("[SixbClient] Connector authorization was cancelled."),
    }
  }
  if (run?.status === "expired") {
    return {
      operation: "resume",
      cause: new Error("[SixbClient] Connector authorization expired before completion."),
    }
  }
  return null
}

function isRunInProgress(run: ConnectorConnectionRun | undefined): boolean {
  return (
    run?.status === "running" ||
    (run?.status === "waiting" && run.waitingFor === "provider_authorization")
  )
}

function isRunTerminal(run: ConnectorConnectionRun | undefined): boolean {
  return run?.status === "failed" || run?.status === "cancelled" || run?.status === "expired"
}

function sameConnectorConnectionCallback(
  left: ConnectorConnectionCallback | null,
  right: ConnectorConnectionCallback
): boolean {
  return left?.connectorId === right.connectorId && left.runId === right.runId
}

export function readConnectorConnectionCallback(
  href: string | undefined = globalThis.location?.href
): ConnectorConnectionCallback | null {
  if (!href) return null
  const url = new URL(href)
  const connectorId = url.searchParams.get(CONNECTOR_CALLBACK_CONNECTOR_PARAM)?.trim()
  const runId = url.searchParams.get(CONNECTOR_CALLBACK_RUN_PARAM)?.trim()
  return connectorId && runId ? { connectorId, runId } : null
}

export function connectorConnectionReturnTo(
  href: string | undefined = globalThis.location?.href
): string {
  if (!href) return ""
  return withoutConnectorConnectionCallback(href).toString()
}

function clearConnectorConnectionCallback(expected: ConnectorConnectionCallback): void {
  const href = globalThis.location?.href
  if (!href || !globalThis.history) return
  const current = readConnectorConnectionCallback(href)
  if (current?.connectorId !== expected.connectorId || current.runId !== expected.runId) {
    return
  }
  const url = withoutConnectorConnectionCallback(href)
  globalThis.history.replaceState(
    globalThis.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  )
}

function withoutConnectorConnectionCallback(href: string): URL {
  const url = new URL(href)
  url.searchParams.delete(CONNECTOR_CALLBACK_CONNECTOR_PARAM)
  url.searchParams.delete(CONNECTOR_CALLBACK_RUN_PARAM)
  return url
}

function redirectToAuthorization(authorizationUrl: string): void {
  if (!globalThis.location) {
    throw new Error("[SixbClient] Connector authorization requires a browser.")
  }
  globalThis.location.assign(authorizationUrl)
}
