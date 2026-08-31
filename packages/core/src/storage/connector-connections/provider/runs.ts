import { parseSixbFailure } from "../../../errors/internal"
import { ConnectorConnectionStorageError } from "../errors"
import type {
  AttachConnectorConnectionRunAuthorizationInput,
  ClaimConnectorConnectionRunCallbackInput,
  ClaimConnectorConnectionRunCallbackResult,
  ConnectorAuthorizationAttemptRecord,
  ConnectorConnectionRunAwaitingProviderRecord,
  ConnectorConnectionRunAwaitingSelectionRecord,
  ConnectorConnectionRunProcessingRecord,
  ConnectorConnectionRunRecord,
  ConnectorConnectionStorage,
  CreateConnectorAuthorizationAttemptInput,
  CreateConnectorConnectionRunInput,
  CreateConnectorConnectionSelectionRunInput,
  FinishConnectorConnectionRunInput,
  GetConnectorConnectionRunInput,
  WaitForConnectorConnectionRunSelectionInput,
} from "../types"
import { CONNECTOR_CONNECTION_RUN_FAILURE_CODES } from "../types"
import {
  assertPositiveDuration,
  authorizationConflict,
  ConnectorConnectionOperations,
  connectionRunBase,
  currentConnectionRun,
  invalidAttempt,
  markPendingAuthorizationForCleanup,
  safeEqual,
} from "./shared"

export class DurableConnectorConnectionRuns extends ConnectorConnectionOperations {
  createAuthorizationAttempt(
    input: CreateConnectorAuthorizationAttemptInput
  ): Promise<ConnectorAuthorizationAttemptRecord> {
    assertPositiveDuration(input.ttlMs, "authorization attempt TTL")
    return this.write(input, async (persistence) => {
      if (input.connectionRunId !== undefined) {
        const run = await persistence.getConnectionRun(input.connectionRunId)
        const existingAttempt = await persistence.getAuthorizationAttemptByConnectionRunId(
          input.connectionRunId
        )
        if (
          !run ||
          existingAttempt ||
          run.status !== "waiting" ||
          run.waitingFor !== "provider_authorization" ||
          run.slot !== input.slot ||
          run.initiatedByExecutionId !== input.initiatedByExecutionId
        ) {
          throw new ConnectorConnectionStorageError(
            "attempt_conflict",
            "[Sixb] Connector authorization attempt does not match its connection run."
          )
        }
      }
      const now = await persistence.now()
      const record: ConnectorAuthorizationAttemptRecord = {
        id: input.id,
        projectId: input.projectId,
        connectorId: input.connectorId,
        owner: structuredClone(input.owner),
        slot: input.slot,
        initiatedByExecutionId: input.initiatedByExecutionId,
        stateHash: input.stateHash,
        codeVerifier: structuredClone(input.codeVerifier),
        redirectUri: input.redirectUri,
        ...(input.connectionRunId === undefined ? {} : { connectionRunId: input.connectionRunId }),
        ...(input.returnTo === undefined ? {} : { returnTo: input.returnTo }),
        ...(input.callbackBindingHash === undefined
          ? {}
          : { callbackBindingHash: input.callbackBindingHash }),
        ...(input.reauthorizationId === undefined
          ? {}
          : { reauthorizationId: input.reauthorizationId }),
        ...(input.reauthorizationRevision === undefined
          ? {}
          : { reauthorizationRevision: input.reauthorizationRevision }),
        ...(input.reauthorizationConnectionIds === undefined
          ? {}
          : { reauthorizationConnectionIds: [...input.reauthorizationConnectionIds] }),
        createdAt: now,
        expiresAt: new Date(now.getTime() + input.ttlMs),
      }
      if (!(await persistence.insertAuthorizationAttempt(record))) {
        throw new ConnectorConnectionStorageError(
          "attempt_conflict",
          "[Sixb] Connector authorization attempt already exists."
        )
      }
      return structuredClone(record)
    })
  }

  async consumeAuthorizationAttempt(
    input: Parameters<ConnectorConnectionStorage["consumeAuthorizationAttempt"]>[0]
  ): Promise<ConnectorAuthorizationAttemptRecord> {
    const record = await this.write(input, async (persistence) => {
      const record = await persistence.getAuthorizationAttempt(input.id)
      const now = await persistence.now()
      if (record && record.expiresAt.getTime() <= now.getTime()) {
        await persistence.deleteAuthorizationAttempt(record.id)
        return null
      }
      if (
        !record ||
        record.redirectUri !== input.redirectUri ||
        !safeEqual(record.stateHash, input.stateHash)
      ) {
        return null
      }

      await persistence.deleteAuthorizationAttempt(input.id)
      return structuredClone(record)
    })
    if (!record) throw invalidAttempt()
    return record
  }

  createConnectionRun(
    input: CreateConnectorConnectionRunInput
  ): Promise<ConnectorConnectionRunRecord> {
    assertPositiveDuration(input.ttlMs, "connection run TTL")
    return this.write(input, async (persistence) => {
      const now = await persistence.now()
      const record: ConnectorConnectionRunAwaitingProviderRecord = {
        id: input.id,
        projectId: input.projectId,
        connectorId: input.connectorId,
        kind: input.kind,
        owner: structuredClone(input.owner),
        slot: input.slot,
        initiatedByExecutionId: input.initiatedByExecutionId,
        status: "waiting",
        waitingFor: "provider_authorization",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + input.ttlMs),
      }
      if (!(await persistence.insertConnectionRun(record))) {
        throw new ConnectorConnectionStorageError(
          "run_conflict",
          "[Sixb] Connector connection run already exists."
        )
      }
      return structuredClone(record)
    })
  }

  createConnectionSelectionRun(
    input: CreateConnectorConnectionSelectionRunInput
  ): Promise<ConnectorConnectionRunAwaitingSelectionRecord> {
    assertPositiveDuration(input.ttlMs, "connection run TTL")
    return this.write(input, async (persistence) => {
      const authorization = await persistence.getAuthorization(input.authorizationId)
      if (!authorization || authorization.status !== "active" || authorization.credentialMutation) {
        throw authorizationConflict()
      }
      const now = await persistence.now()
      const record: ConnectorConnectionRunAwaitingSelectionRecord = {
        id: input.id,
        projectId: input.projectId,
        connectorId: input.connectorId,
        kind: "connect",
        owner: structuredClone(input.owner),
        slot: input.slot,
        initiatedByExecutionId: input.initiatedByExecutionId,
        status: "waiting",
        waitingFor: "account_selection",
        authorizationId: input.authorizationId,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + input.ttlMs),
      }
      if (!(await persistence.insertConnectionRun(record))) {
        throw new ConnectorConnectionStorageError(
          "run_conflict",
          "[Sixb] Connector connection run already exists."
        )
      }
      return structuredClone(record)
    })
  }

  async claimConnectionRunCallback(
    input: ClaimConnectorConnectionRunCallbackInput
  ): Promise<ClaimConnectorConnectionRunCallbackResult | null> {
    assertPositiveDuration(input.processingTtlMs, "connection run processing TTL")
    // Resolve the opaque attempt before entering the connector-scoped critical section. The
    // transaction re-reads every proof, but now all writers acquire the connector lock before row
    // locks instead of letting callback and expiry paths lock attempt/run rows in opposite orders.
    const candidate = await this.read({ projectId: input.projectId }, (persistence) =>
      persistence.getAuthorizationAttempt(input.attemptId)
    )
    if (!candidate) return null

    return this.write(
      { projectId: input.projectId, connectorId: candidate.connectorId },
      async (persistence) => {
        const attempt = await persistence.getAuthorizationAttempt(input.attemptId)
        if (
          !attempt ||
          attempt.connectionRunId === undefined ||
          attempt.returnTo === undefined ||
          attempt.callbackBindingHash === undefined ||
          attempt.redirectUri !== input.redirectUri ||
          !safeEqual(attempt.stateHash, input.stateHash) ||
          !safeEqual(attempt.callbackBindingHash, input.callbackBindingHash)
        ) {
          return null
        }

        const run = await persistence.getConnectionRun(attempt.connectionRunId)
        if (
          !run ||
          run.status !== "waiting" ||
          run.waitingFor !== "provider_authorization" ||
          run.slot !== attempt.slot ||
          run.initiatedByExecutionId !== attempt.initiatedByExecutionId
        ) {
          return null
        }

        const now = await persistence.now()
        await persistence.deleteAuthorizationAttempt(attempt.id)
        if (
          attempt.expiresAt.getTime() <= now.getTime() ||
          run.expiresAt.getTime() <= now.getTime()
        ) {
          const expired: Extract<ConnectorConnectionRunRecord, { status: "expired" }> = {
            ...connectionRunBase(run, now),
            status: "expired",
            finishedAt: now,
          }
          await persistence.updateConnectionRun(expired)
          return { type: "expired", run: structuredClone(expired), returnTo: attempt.returnTo }
        }

        const processing: ConnectorConnectionRunProcessingRecord = {
          ...connectionRunBase(run, now),
          status: "running",
          processingId: input.processingId,
          callbackStartedAt: now,
          expiresAt: new Date(now.getTime() + input.processingTtlMs),
          ...(attempt.reauthorizationId === undefined
            ? {}
            : { authorizationId: attempt.reauthorizationId }),
        }
        await persistence.updateConnectionRun(processing)
        return {
          type: "claimed",
          run: structuredClone(processing),
          attempt: structuredClone(attempt),
          returnTo: attempt.returnTo,
        }
      }
    )
  }

  attachConnectionRunAuthorization(
    input: AttachConnectorConnectionRunAuthorizationInput
  ): Promise<ConnectorConnectionRunProcessingRecord | null> {
    return this.write(input, async (persistence) => {
      const run = await currentConnectionRun(persistence, input.runId)
      const authorization = await persistence.getAuthorization(input.authorizationId)
      if (
        !run ||
        run.status !== "running" ||
        run.processingId !== input.processingId ||
        (run.authorizationId !== undefined && run.authorizationId !== input.authorizationId) ||
        !authorization ||
        authorization.status !== "pending_selection"
      ) {
        return null
      }
      const updated: ConnectorConnectionRunProcessingRecord = {
        ...run,
        authorizationId: input.authorizationId,
        updatedAt: await persistence.now(),
      }
      await persistence.updateConnectionRun(updated)
      return structuredClone(updated)
    })
  }

  waitForConnectionRunSelection(
    input: WaitForConnectorConnectionRunSelectionInput
  ): Promise<ConnectorConnectionRunAwaitingSelectionRecord | null> {
    return this.write(input, async (persistence) => {
      const run = await currentConnectionRun(persistence, input.runId)
      if (
        !run ||
        run.status !== "running" ||
        run.kind !== "connect" ||
        run.processingId !== input.processingId ||
        run.authorizationId !== input.authorizationId
      ) {
        return null
      }
      const now = await persistence.now()
      const waiting: ConnectorConnectionRunAwaitingSelectionRecord = {
        ...connectionRunBase(run, now),
        status: "waiting",
        waitingFor: "account_selection",
        authorizationId: input.authorizationId,
        expiresAt: new Date(input.expiresAt),
      }
      await persistence.updateConnectionRun(waiting)
      return structuredClone(waiting)
    })
  }

  finishConnectionRun(
    input: FinishConnectorConnectionRunInput
  ): Promise<ConnectorConnectionRunRecord | null> {
    return this.write(input, async (persistence) => {
      const run = await currentConnectionRun(persistence, input.runId)
      if (!run || run.status !== "running" || input.processingId !== run.processingId) return null
      const now = await persistence.now()
      const authorizationId =
        input.status === "succeeded"
          ? input.authorizationId
          : input.status === "failed"
            ? (input.authorizationId ?? run.authorizationId)
            : run.authorizationId
      if (input.status !== "succeeded" && run.kind === "connect" && authorizationId) {
        await markPendingAuthorizationForCleanup(persistence, authorizationId, now)
      }
      const base = connectionRunBase(run, now)
      const finished: ConnectorConnectionRunRecord =
        input.status === "succeeded"
          ? {
              ...base,
              status: "succeeded",
              authorizationId: input.authorizationId,
              ...(input.cleanupAuthorizationId === undefined
                ? {}
                : { cleanupAuthorizationId: input.cleanupAuthorizationId }),
              connections: structuredClone(input.connections),
              finishedAt: now,
            }
          : input.status === "failed"
            ? {
                ...base,
                status: "failed",
                ...(authorizationId === undefined ? {} : { authorizationId }),
                error: parseSixbFailure(input.error, CONNECTOR_CONNECTION_RUN_FAILURE_CODES),
                finishedAt: now,
              }
            : {
                ...base,
                status: "cancelled",
                ...(authorizationId === undefined ? {} : { authorizationId }),
                finishedAt: now,
              }
      await persistence.updateConnectionRun(finished)
      return structuredClone(finished)
    })
  }

  getConnectionRun(
    input: GetConnectorConnectionRunInput
  ): Promise<ConnectorConnectionRunRecord | null> {
    return this.write(input, async (persistence) => {
      const run = await currentConnectionRun(persistence, input.runId)
      return run ? structuredClone(run) : null
    })
  }
}
