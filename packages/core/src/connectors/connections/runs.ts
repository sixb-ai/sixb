import { randomBytes, randomUUID } from "node:crypto"
import { captureSixbFailure, isSixbError } from "../../errors/internal"
import { ensureExecutionRecord } from "../../execution/durable"
import {
  CONNECTOR_CONNECTION_RUN_FAILURE_CODES,
  type ConnectorAuthorizationRecord,
  type ConnectorConnectionRunProcessingRecord,
  type ConnectorConnectionRunRecord,
  type ConnectorConnectionStorage,
  type Storage,
} from "../../storage"
import { createConnectorCodedError, isConnectorStorageError, storageBoundaryError } from "../errors"
import {
  assertConnectorAuthorizationActor,
  type DefaultConnectorAuthorizationLifecycle,
} from "./authorizations"
import {
  assertConnectorConnectionRunInitiator,
  requireConnectorConnectionCommandActor,
} from "./command-context"
import type {
  CompleteConnectorConnectionRunInput,
  CompleteConnectorConnectionRunResult,
  ConnectorConnectionCommandContext,
  ConnectorConnectionRunView,
  SelectConnectorConnectionRunAccountInput,
  StartConnectorConnectionRunInput,
  StartConnectorConnectionRunResult,
} from "./contracts"
import type {
  ConnectorAuthorizationRequestHandler,
  ResolveOAuthConnectorDefinition,
} from "./request"
import { withConnectorStorageBoundary } from "./storage-boundary"
import {
  hashSecret,
  nonblank,
  normalizedHttpUrl,
  parseAttemptId,
  positiveDuration,
} from "./validation"
import { connectorConnectionView } from "./views"

const CLEANUP_RETRY_DELAY_MS = 30_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface ConnectorConnectionRunServiceOptions {
  readonly projectId: string
  readonly storage: Storage
  readonly requestHandler: ConnectorAuthorizationRequestHandler
  readonly authorizations: DefaultConnectorAuthorizationLifecycle
  readonly resolveDefinition: ResolveOAuthConnectorDefinition
  readonly processingTtlMs: number
  readonly selectionTtlMs: number
  readonly now: () => Date
}

/** Durable orchestration for the user-visible connector connection flow. */
export class ConnectorConnectionRunService {
  private readonly projectId: string
  private readonly storage: Storage
  private readonly connectionStorage: ConnectorConnectionStorage
  private readonly requests: ConnectorAuthorizationRequestHandler
  private readonly authorizations: DefaultConnectorAuthorizationLifecycle
  private readonly resolveDefinition: ResolveOAuthConnectorDefinition
  private readonly processingTtlMs: number
  private readonly selectionTtlMs: number
  private readonly now: () => Date
  private readonly maintenanceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: ConnectorConnectionRunServiceOptions) {
    this.projectId = options.projectId
    this.storage = options.storage
    this.connectionStorage = requireConnectorConnectionStorage(options.storage)
    this.requests = options.requestHandler
    this.authorizations = options.authorizations
    this.resolveDefinition = options.resolveDefinition
    this.processingTtlMs = positiveDuration(
      options.processingTtlMs,
      "connection run processing TTL"
    )
    this.selectionTtlMs = positiveDuration(options.selectionTtlMs, "account selection TTL")
    this.now = options.now
  }

  async startSelection(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: {
      readonly owner: StartConnectorConnectionRunInput["owner"]
      readonly slot: string
      readonly authorizationId: string
    }
  ): Promise<ConnectorConnectionRunView> {
    const runId = `ccr_${randomUUID()}`
    let run: ConnectorConnectionRunRecord
    try {
      run = await this.storage.transaction(
        async (tx) => {
          await ensureExecutionRecord(tx.executions, command.execution)
          return requireConnectorConnectionStorage(tx).createConnectionSelectionRun({
            id: runId,
            projectId: this.projectId,
            connectorId,
            owner: input.owner,
            slot: input.slot,
            initiatedByExecutionId: command.execution.id,
            authorizationId: input.authorizationId,
            ttlMs: this.selectionTtlMs,
          })
        },
        { isolation: "serializable" }
      )
    } catch (error) {
      throw storageBoundaryError(error, "Connector account-selection run could not be persisted.")
    }
    this.scheduleRunMaintenance(run, this.selectionTtlMs + 1)
    return this.view(run)
  }

  async start(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: StartConnectorConnectionRunInput
  ): Promise<StartConnectorConnectionRunResult> {
    const returnTo = normalizedHttpUrl(input.returnTo, "connector return URL")
    const prepared = await this.requests.prepareAuthorizationRequest(command, connectorId, input)
    const runId = `ccr_${randomUUID()}`
    const callbackBinding = randomBytes(32).toString("base64url")

    let expiresAt: Date
    try {
      expiresAt = await this.storage.transaction(
        async (tx) => {
          await ensureExecutionRecord(tx.executions, command.execution)
          const connections = requireConnectorConnectionStorage(tx)
          await connections.createConnectionRun({
            id: runId,
            projectId: this.projectId,
            connectorId: prepared.definition.id,
            kind: prepared.attempt.reauthorizationId === undefined ? "connect" : "reauthorize",
            owner: prepared.attempt.owner,
            slot: prepared.attempt.slot,
            initiatedByExecutionId: command.execution.id,
            authorizationAttemptId: prepared.attempt.id,
            ttlMs: prepared.attempt.ttlMs,
          })
          const attempt = await connections.createAuthorizationAttempt({
            ...prepared.attempt,
            connectionRunId: runId,
            returnTo,
            callbackBindingHash: hashSecret(callbackBinding),
          })
          return attempt.expiresAt
        },
        { isolation: "serializable" }
      )
    } catch (error) {
      throw storageBoundaryError(error, "Connector connection run could not be persisted.")
    }

    return {
      runId,
      authorizationUrl: prepared.authorizationUrl,
      affectedConnections: prepared.affectedConnections,
      callbackBinding: {
        attemptId: prepared.attempt.id,
        secret: callbackBinding,
        expiresAt,
      },
    }
  }

  async complete(
    input: CompleteConnectorConnectionRunInput
  ): Promise<CompleteConnectorConnectionRunResult> {
    const state = nonblank(input.state, "OAuth state", "connector.authorization_invalid")
    const redirectUri = normalizedHttpUrl(input.redirectUri, "OAuth callback URL")
    const callbackBinding = nonblank(
      input.callbackBinding,
      "OAuth callback binding",
      "connector.authorization_invalid"
    )
    const claimed = await this.claimCallback(state, callbackBinding, redirectUri)
    if (claimed.type === "expired") {
      return {
        runId: claimed.run.id,
        connectorId: claimed.run.connectorId,
        returnTo: claimed.returnTo,
      }
    }

    const { run, attempt, principal, returnTo } = claimed
    this.scheduleRunMaintenance(run, this.processingTtlMs + 1)
    if ("error" in input) {
      const finished =
        input.error === "access_denied"
          ? await this.cancelRun(run)
          : await this.failRun(run, providerCallbackError(input.error))
      return { runId: finished.id, connectorId: finished.connectorId, returnTo }
    }

    let authorizationId = run.authorizationId
    try {
      const definition = this.resolveDefinition(attempt.connectorId)
      const authorization = await this.requests.completeAuthorizationAttempt({
        definition,
        attempt,
        principal,
        code: nonblank(input.code, "OAuth authorization code", "connector.authorization_invalid"),
        redirectUri,
        onAuthorizationPersisted: async (persisted) => {
          authorizationId = persisted.id
          const attached = await withConnectorStorageBoundary(
            "Connector authorization could not be attached to its run.",
            () =>
              this.connectionStorage.attachConnectionRunAuthorization({
                projectId: this.projectId,
                connectorId: run.connectorId,
                runId: run.id,
                processingId: run.processingId,
                authorizationId: persisted.id,
              })
          )
          if (!attached) {
            throw createConnectorCodedError(
              "internal.unexpected",
              "Connector authorization arrived after its run stopped accepting results."
            )
          }
        },
      })
      const finished = await this.finalizeCompletedRun(run, authorization)
      return { runId: finished.id, connectorId: finished.connectorId, returnTo }
    } catch (error) {
      const failed = await this.failRun(run, error, authorizationId)
      return { runId: failed.id, connectorId: failed.connectorId, returnTo }
    }
  }

  async get(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    runId: string
  ): Promise<ConnectorConnectionRunView | null> {
    const id = nonblank(runId, "connection run id")
    const run = await this.readRun(connectorId, id)
    if (!run) return null
    await this.assertRunActor(command, run)
    if (run.status === "waiting" || run.status === "running") {
      if (!this.maintenanceTimers.has(run.id)) this.scheduleRunMaintenance(run)
    } else if (!(await this.continueRunCleanup(run))) {
      this.scheduleRunMaintenance(run, CLEANUP_RETRY_DELAY_MS)
    } else {
      this.cancelRunMaintenance(run.id)
    }
    return this.view(run)
  }

  async selectAccount(
    command: ConnectorConnectionCommandContext,
    connectorId: string,
    input: SelectConnectorConnectionRunAccountInput
  ): Promise<ConnectorConnectionRunView> {
    const definition = this.resolveDefinition(connectorId)
    const runId = nonblank(input.runId, "connection run id")
    const run = await this.readRun(definition.id, runId)
    if (!run) {
      throw createConnectorCodedError("connector.not_found", "Connector connection run not found.")
    }
    const actor = await this.assertRunActor(command, run)
    if (run.status !== "waiting" || run.waitingFor !== "account_selection") {
      throw createConnectorCodedError(
        "connector.operation_conflict",
        "Connector connection run is not waiting for account selection."
      )
    }

    const authorization = await this.authorizations.requireAuthorization(
      definition.id,
      run.authorizationId
    )
    assertConnectorAuthorizationActor(authorization, actor.principal)
    const account = authorization.accounts.find((candidate) => candidate.id === input.accountId)
    if (!account) {
      throw createConnectorCodedError(
        "connector.not_found",
        `Account '${input.accountId}' is not exposed by this connector connection run.`
      )
    }

    let selected: Awaited<ReturnType<ConnectorConnectionStorage["putConnectionFromRun"]>>
    try {
      selected = await this.connectionStorage.putConnectionFromRun({
        id: `ccn_${randomUUID()}`,
        projectId: this.projectId,
        connectorId: definition.id,
        runId: run.id,
        account,
        replace: input.replace === true,
      })
    } catch (error) {
      if (isConnectorStorageError(error, "run_invalid")) {
        const latest = await this.readRun(definition.id, run.id)
        if (latest) await this.continueRunCleanup(latest)
        throw createConnectorCodedError(
          "connector.operation_conflict",
          "Connector connection run is no longer waiting for account selection.",
          { cause: error }
        )
      }
      if (isConnectorStorageError(error, "authorization_conflict")) {
        throw createConnectorCodedError(
          "connector.operation_conflict",
          "Connector authorization cannot be selected in its current state.",
          { cause: error }
        )
      }
      if (isConnectorStorageError(error, "connection_conflict")) {
        throw createConnectorCodedError(
          "connector.operation_conflict",
          "Connector slot is already occupied; explicit replacement is required.",
          { cause: error }
        )
      }
      throw storageBoundaryError(error, "Connector account selection could not be persisted.")
    }
    const cleanupCompleted = selected.revocationPendingAuthorizationId
      ? await this.continuePendingRevocation(
          definition.id,
          selected.revocationPendingAuthorizationId
        )
      : true
    if (cleanupCompleted) {
      this.cancelRunMaintenance(run.id)
    } else {
      this.scheduleRunMaintenance(selected.run, CLEANUP_RETRY_DELAY_MS)
    }
    return this.view(selected.run)
  }

  private async claimCallback(state: string, callbackBinding: string, redirectUri: string) {
    let claimed:
      | {
          readonly type: "claimed"
          readonly run: ConnectorConnectionRunProcessingRecord
          readonly attempt: Awaited<
            ReturnType<ConnectorConnectionStorage["consumeAuthorizationAttempt"]>
          >
          readonly principal: ReturnType<typeof requireConnectorConnectionCommandActor>["principal"]
          readonly returnTo: string
        }
      | {
          readonly type: "expired"
          readonly run: Extract<ConnectorConnectionRunRecord, { readonly status: "expired" }>
          readonly returnTo: string
        }
      | null

    try {
      claimed = await this.storage.transaction(
        async (tx) => {
          const result = await requireConnectorConnectionStorage(tx).claimConnectionRunCallback({
            projectId: this.projectId,
            attemptId: parseAttemptId(state),
            stateHash: hashSecret(state),
            callbackBindingHash: hashSecret(callbackBinding),
            redirectUri,
            processingId: `ccp_${randomUUID()}`,
            processingTtlMs: this.processingTtlMs,
          })
          if (!result || result.type === "expired") return result
          const execution = await tx.executions.getById({
            projectId: this.projectId,
            id: result.attempt.initiatedByExecutionId,
          })
          if (!execution) {
            throw createConnectorCodedError(
              "internal.unexpected",
              "Connector connection run initiating execution is unavailable."
            )
          }
          const actor = requireConnectorConnectionCommandActor(execution, this.projectId)
          return { ...result, principal: actor.principal }
        },
        { isolation: "serializable" }
      )
    } catch (error) {
      throw storageBoundaryError(error, "Connector connection run callback could not be claimed.")
    }

    if (!claimed) {
      throw createConnectorCodedError(
        "connector.authorization_invalid",
        "Connector connection run is invalid, expired, or already used."
      )
    }
    return claimed
  }

  private async finalizeCompletedRun(
    run: ConnectorConnectionRunProcessingRecord,
    authorization: ConnectorAuthorizationRecord
  ): Promise<ConnectorConnectionRunRecord> {
    if (run.kind === "connect") {
      if (!authorization.selectionExpiresAt) {
        throw createConnectorCodedError(
          "internal.unexpected",
          "Connector authorization is missing its account-selection deadline."
        )
      }
      const selectionExpiresAt = authorization.selectionExpiresAt
      const waiting = await withConnectorStorageBoundary(
        "Connector connection run could not wait for account selection.",
        () =>
          this.connectionStorage.waitForConnectionRunSelection({
            projectId: this.projectId,
            connectorId: run.connectorId,
            runId: run.id,
            processingId: run.processingId,
            authorizationId: authorization.id,
            expiresAt: selectionExpiresAt,
          })
      )
      if (waiting) {
        this.scheduleRunMaintenance(waiting, this.selectionTtlMs + 1)
        return waiting
      }
    } else {
      const connections = await withConnectorStorageBoundary(
        "Reauthorized connector connections could not be read.",
        () =>
          this.connectionStorage.listConnectionsByAuthorization({
            projectId: this.projectId,
            connectorId: run.connectorId,
            authorizationId: authorization.id,
          })
      )
      const succeeded = await withConnectorStorageBoundary(
        "Connector reauthorization run could not be finalized.",
        () =>
          this.connectionStorage.finishConnectionRun({
            projectId: this.projectId,
            connectorId: run.connectorId,
            runId: run.id,
            processingId: run.processingId,
            status: "succeeded",
            authorizationId: authorization.id,
            connections,
          })
      )
      if (succeeded) {
        this.cancelRunMaintenance(run.id)
        return succeeded
      }
    }
    throw createConnectorCodedError(
      "internal.unexpected",
      "Connector connection run could not be finalized."
    )
  }

  private async failRun(
    run: ConnectorConnectionRunProcessingRecord,
    error: unknown,
    authorizationId = run.authorizationId
  ): Promise<ConnectorConnectionRunRecord> {
    const failed = await withConnectorStorageBoundary(
      "Connector connection run failure could not be persisted.",
      () =>
        this.connectionStorage.finishConnectionRun({
          projectId: this.projectId,
          connectorId: run.connectorId,
          runId: run.id,
          processingId: run.processingId,
          status: "failed",
          ...(authorizationId === undefined ? {} : { authorizationId }),
          error: captureSixbFailure(error, {
            allowedCodes: CONNECTOR_CONNECTION_RUN_FAILURE_CODES,
            defaultCode: "internal.unexpected",
            at: this.now(),
          }),
        })
    )
    if (failed) {
      this.cancelRunMaintenance(run.id)
      if (!(await this.continueRunCleanup(failed))) {
        this.scheduleRunMaintenance(failed, CLEANUP_RETRY_DELAY_MS)
      }
      return failed
    }
    throw createConnectorCodedError(
      "internal.unexpected",
      "Connector connection run failure could not be persisted.",
      { cause: error }
    )
  }

  private async cancelRun(
    run: ConnectorConnectionRunProcessingRecord
  ): Promise<ConnectorConnectionRunRecord> {
    const cancelled = await withConnectorStorageBoundary(
      "Connector connection run cancellation could not be persisted.",
      () =>
        this.connectionStorage.finishConnectionRun({
          projectId: this.projectId,
          connectorId: run.connectorId,
          runId: run.id,
          processingId: run.processingId,
          status: "cancelled",
        })
    )
    if (cancelled) {
      this.cancelRunMaintenance(run.id)
      return cancelled
    }
    throw createConnectorCodedError(
      "internal.unexpected",
      "Connector connection run cancellation could not be persisted."
    )
  }

  private async readRun(
    connectorId: string,
    runId: string
  ): Promise<ConnectorConnectionRunRecord | null> {
    try {
      return await this.connectionStorage.getConnectionRun({
        projectId: this.projectId,
        connectorId,
        runId,
      })
    } catch (error) {
      throw storageBoundaryError(error, "Connector connection run could not be read.")
    }
  }

  private async assertRunActor(
    command: ConnectorConnectionCommandContext,
    run: ConnectorConnectionRunRecord
  ) {
    const actor = requireConnectorConnectionCommandActor(command.execution, this.projectId)
    const initiating = await withConnectorStorageBoundary(
      "Connector connection run initiating execution could not be read.",
      () =>
        this.storage.executions.getById({
          projectId: this.projectId,
          id: run.initiatedByExecutionId,
        })
    )
    assertConnectorConnectionRunInitiator(initiating, actor, run.connectorId)
    return actor
  }

  private async view(run: ConnectorConnectionRunRecord): Promise<ConnectorConnectionRunView> {
    const base = {
      id: run.id,
      connectorId: run.connectorId,
      kind: run.kind,
      owner: run.owner,
      slot: run.slot,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }
    if (run.status === "running") return { ...base, status: "running" }
    if (run.status === "waiting" && run.waitingFor === "provider_authorization") {
      return {
        ...base,
        status: "waiting",
        waitingFor: "provider_authorization",
        expiresAt: run.expiresAt,
      }
    }
    if (run.status === "waiting") {
      const authorization = await this.authorizations.requireAuthorization(
        run.connectorId,
        run.authorizationId
      )
      return {
        ...base,
        status: "waiting",
        waitingFor: "account_selection",
        accounts: authorization.accounts,
        expiresAt: run.expiresAt,
      }
    }
    if (run.status === "succeeded") {
      return {
        ...base,
        status: "succeeded",
        connections: run.connections.map((connection) =>
          connectorConnectionView(connection, "active")
        ),
        finishedAt: run.finishedAt,
      }
    }
    if (run.status === "failed") {
      return { ...base, status: "failed", error: run.error, finishedAt: run.finishedAt }
    }
    return { ...base, status: run.status, finishedAt: run.finishedAt }
  }

  close(): void {
    for (const timer of this.maintenanceTimers.values()) clearTimeout(timer)
    this.maintenanceTimers.clear()
  }

  private async continueRunCleanup(run: ConnectorConnectionRunRecord): Promise<boolean> {
    if (run.kind !== "connect") return true
    const authorizationId =
      run.status === "succeeded"
        ? run.cleanupAuthorizationId
        : run.status === "failed" || run.status === "expired" || run.status === "cancelled"
          ? run.authorizationId
          : undefined
    if (authorizationId === undefined) return true
    const authorization = await this.authorizations.requireAuthorization(
      run.connectorId,
      authorizationId
    )
    if (authorization.status !== "revocation_pending") return true
    return this.continuePendingRevocation(run.connectorId, authorization.id)
  }

  private async continuePendingRevocation(
    connectorId: string,
    authorizationId: string
  ): Promise<boolean> {
    try {
      await this.authorizations.continuePendingRevocation(
        this.resolveDefinition(connectorId),
        authorizationId
      )
      return true
    } catch (error) {
      if (isSixbError(error) && error.code === "connector.revocation_pending") return false
      throw error
    }
  }

  private scheduleRunMaintenance(
    run: ConnectorConnectionRunRecord,
    delayMs = run.status === "waiting" || run.status === "running"
      ? Math.max(1_000, run.expiresAt.getTime() - this.now().getTime())
      : CLEANUP_RETRY_DELAY_MS
  ): void {
    this.cancelRunMaintenance(run.id)
    const timer = setTimeout(
      () => void this.maintainRun(run.connectorId, run.id),
      Math.min(delayMs, MAX_TIMER_DELAY_MS)
    )
    timer.unref?.()
    this.maintenanceTimers.set(run.id, timer)
  }

  private cancelRunMaintenance(runId: string): void {
    const timer = this.maintenanceTimers.get(runId)
    if (timer) clearTimeout(timer)
    this.maintenanceTimers.delete(runId)
  }

  private async maintainRun(connectorId: string, runId: string): Promise<void> {
    this.maintenanceTimers.delete(runId)
    try {
      const run = await this.readRun(connectorId, runId)
      if (!run) return
      if (run.status === "waiting" || run.status === "running") {
        this.scheduleRunMaintenance(run)
        return
      }
      if (!(await this.continueRunCleanup(run))) {
        this.scheduleRunMaintenance(run, CLEANUP_RETRY_DELAY_MS)
      }
    } catch {
      console.warn("[Sixb] Connector connection run cleanup failed and will be retried.")
      const timer = setTimeout(
        () => void this.maintainRun(connectorId, runId),
        CLEANUP_RETRY_DELAY_MS
      )
      timer.unref?.()
      this.maintenanceTimers.set(runId, timer)
    }
  }
}

function requireConnectorConnectionStorage(storage: Storage): ConnectorConnectionStorage {
  if (storage.connectorConnections) return storage.connectorConnections
  throw createConnectorCodedError(
    "internal.unexpected",
    "Connector connection storage is unavailable."
  )
}

function providerCallbackError(error: string): ReturnType<typeof createConnectorCodedError> {
  const code =
    error === "server_error" || error === "temporarily_unavailable"
      ? "connector.provider_unavailable"
      : "connector.provider_failed"
  return createConnectorCodedError(
    code,
    "Connector provider could not complete the authorization request."
  )
}
