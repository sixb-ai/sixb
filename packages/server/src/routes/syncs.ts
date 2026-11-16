import type { SixbHostView, SyncAccount, SyncDefinition } from "@sixb/core"
import { isOAuthConnectorDefinition } from "@sixb/core/internal/connector-connections"
import type { SyncRunRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ConnectionSyncRunsParamsSchema,
  ConnectionSyncRunsResponseSchema,
  ConnectorAccountListResponseSchema,
  ConnectorAccountsParamsSchema,
  RequestSyncRunBodySchema,
  RequestSyncRunResponseSchema,
  SyncParamsSchema,
  SyncRunListResponseSchema,
  SyncRunsQuerySchema,
  SyncSchema,
} from "../schemas/syncs"
import {
  handleRouteError,
  parseDate,
  parseOptionalInt,
  toIsoString,
  unconfiguredStorageResponse,
} from "../utils/http"

function serializeSyncRun(run: SyncRunRecord) {
  return {
    id: run.id,
    projectId: run.projectId,
    syncId: run.syncId,
    connectionId: run.connectionId,
    datasetId: run.datasetId,
    mode: run.mode,
    status: run.status,
    attempt: run.attempt,
    queuedAt: toIsoString(run.queuedAt),
    startedAt: run.startedAt ? toIsoString(run.startedAt) : undefined,
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
    rowsRead: run.rowsRead,
    output: run.output,
    expectedLatestVersionId: run.expectedLatestVersionId,
    commitMessage: run.commitMessage,
    error: run.error,
  }
}

type SerializedSyncRun = ReturnType<typeof serializeSyncRun>

async function getLatestSyncRun(
  sixb: ReturnType<typeof requireRequestSixb>,
  syncId: string
): Promise<SerializedSyncRun | null> {
  const result = await sixb.syncs.runs.listLatest([syncId])

  const [latest] = result.runs
  return latest ? serializeSyncRun(latest) : null
}

async function getLatestSyncRuns(
  sixb: ReturnType<typeof requireRequestSixb>,
  syncIds: readonly string[]
): Promise<Map<string, SerializedSyncRun>> {
  if (syncIds.length === 0) {
    return new Map()
  }

  const result = await sixb.syncs.runs.listLatest(syncIds)

  return new Map(result.runs.map((run) => [run.syncId, serializeSyncRun(run)]))
}

function serializeAccount(account: SyncAccount) {
  const { id, owner, slot, account: candidate } = account.connection
  return {
    connection: { id, owner, slot, account: { id: candidate.id, label: candidate.label } },
    latestRuns: account.latestRuns.map(serializeSyncRun),
  }
}

type RequestSixb = ReturnType<typeof requireRequestSixb>

/** Each connector's accounts, read once however many of its syncs a response describes. */
function connectorAccounts(sixb: RequestSixb) {
  const byConnector = new Map<string, Promise<readonly SyncAccount[]>>()
  return (connectorId: string) => {
    let accounts = byConnector.get(connectorId)
    if (!accounts) {
      accounts = sixb.syncs.accounts.list(connectorId)
      byConnector.set(connectorId, accounts)
    }
    return accounts
  }
}

/** On a sync of an OAuth connector, how the accounts the caller may see stand in it. */
async function summarizeAccounts(
  sync: SyncDefinition,
  accountsOf: ReturnType<typeof connectorAccounts>
) {
  if (!isOAuthConnectorDefinition(sync.connector)) return undefined
  const accounts = await accountsOf(sync.connector.id)
  const failed = accounts.flatMap(({ latestRuns }) =>
    latestRuns.filter((run) => run.syncId === sync.id && run.status === "failed")
  )
  const needsReconnecting = failed.filter(
    (run) => run.error?.code === "connector.authorization_required"
  ).length
  return {
    total: accounts.length,
    needsReconnecting,
    failing: failed.length - needsReconnecting,
  }
}

function serializeSync(
  sync: SyncDefinition,
  latestRun: SerializedSyncRun | null,
  accounts?: Awaited<ReturnType<typeof summarizeAccounts>>
): ReturnType<typeof SyncSchema.parse> {
  return SyncSchema.parse({
    id: sync.id,
    mode: sync.config.mode,
    connector: {
      id: sync.connector.id,
      type: sync.connector.adapter.type,
    },
    target: {
      kind: "dataset",
      dataset: sync.target.dataset,
    },
    triggers: sync.triggers,
    latestRun,
    ...(accounts === undefined ? {} : { accounts }),
  })
}

export function registerSyncRoutes(app: Elysia, host: SixbHostView) {
  return app
    .get(
      "/api/syncs",
      async (context) => {
        const sixb = requireRequestSixb(context)
        const syncs = sixb.syncs.list()
        const latestRuns = await getLatestSyncRuns(
          sixb,
          syncs.map((sync) => sync.id)
        )
        const accountsOf = connectorAccounts(sixb)

        return Promise.all(
          syncs.map(async (sync) =>
            serializeSync(
              sync,
              latestRuns.get(sync.id) ?? null,
              await summarizeAccounts(sync, accountsOf)
            )
          )
        )
      },
      {
        response: { 200: SyncSchema.array() },
        detail: {
          summary: "List registered syncs",
          tags: [OPENAPI_TAGS.syncs.name],
          operationId: "listSyncs",
          security: accessTokenSecurityRequirement("listSyncs"),
        },
      }
    )
    .get(
      "/api/syncs/:syncId",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        const sync = sixb.syncs.getById(params.syncId)
        if (!sync) {
          set.status = 404
          return { error: "Sync not found" }
        }

        return serializeSync(
          sync,
          await getLatestSyncRun(sixb, sync.id),
          await summarizeAccounts(sync, connectorAccounts(sixb))
        )
      },
      {
        params: SyncParamsSchema,
        response: { 200: SyncSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get sync metadata",
          tags: [OPENAPI_TAGS.syncs.name],
          operationId: "getSync",
          security: accessTokenSecurityRequirement("getSync"),
        },
      }
    )
    .get(
      "/api/connectors/:connectorId/accounts",
      async (context) => {
        const { params } = context
        const sixb = requireRequestSixb(context)
        const accounts = await sixb.syncs.accounts.list(params.connectorId)
        return { accounts: accounts.map(serializeAccount) }
      },
      {
        params: ConnectorAccountsParamsSchema,
        response: { 200: ConnectorAccountListResponseSchema },
        detail: {
          summary: "List a connector's accounts and how they synced",
          description:
            "On an OAuth connector, each connected account you may see, with the latest run of each of its syncs you may run. Empty for a static connector.",
          tags: [OPENAPI_TAGS.connectorConnections.name],
          operationId: "listConnectorAccounts",
          security: accessTokenSecurityRequirement("listConnectorAccounts"),
        },
      }
    )
    .get(
      "/api/connectors/:connectorId/connections/:connectionId/sync-runs",
      async (context) => {
        const { params } = context
        const sixb = requireRequestSixb(context)
        const runs = await sixb.syncs.accounts.latestRuns(params.connectorId, params.connectionId)
        return { runs: runs.map(serializeSyncRun) }
      },
      {
        params: ConnectionSyncRunsParamsSchema,
        response: { 200: ConnectionSyncRunsResponseSchema },
        detail: {
          summary: "Latest sync runs of a connection",
          description:
            "The latest run of each sync of one connection: your own, or anyone's with can.manage on its connector. Empty for a connection you don't see.",
          tags: [OPENAPI_TAGS.connectorConnections.name],
          operationId: "listConnectorConnectionSyncRuns",
        },
      }
    )
    .get(
      "/api/sync-runs",
      async (context) => {
        const { query, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const parsed = SyncRunsQuerySchema.parse(query)
          const storage = host.storage.syncRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Sync run storage")
          }

          const result = await sixb.syncs.runs.list({
            syncId: parsed.syncId,
            ...(parsed.connectionId === undefined ? {} : { connectionId: parsed.connectionId }),
            datasetId: parsed.datasetId,
            statuses: parsed.status ? [parsed.status] : undefined,
            startedAfter: parseDate(parsed.startedAfter),
            startedBefore: parseDate(parsed.startedBefore),
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          })

          return {
            runs: result.runs.map(serializeSyncRun),
            hasMore: result.hasMore,
            total: result.total,
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: SyncRunsQuerySchema,
        response: {
          200: SyncRunListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List sync run history",
          tags: [OPENAPI_TAGS.syncRuns.name],
          operationId: "listSyncRuns",
          security: accessTokenSecurityRequirement("listSyncRuns"),
        },
      }
    )
    .post(
      "/api/syncs/:syncId/runs",
      async (context) => {
        const { params, body, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const parsedBody = RequestSyncRunBodySchema.parse(body)
          const result = await sixb.syncs.request({ syncId: params.syncId, ...parsedBody })

          set.status = 202
          return {
            runs: result.runs.map((run) => ({
              runId: run.runId,
              jobId: run.jobId ?? "",
              syncId: run.syncId,
              connectionId: run.connectionId,
              queuedAt: run.queuedAt,
            })),
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: SyncParamsSchema,
        body: RequestSyncRunBodySchema,
        response: {
          202: RequestSyncRunResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Request a sync run",
          tags: [OPENAPI_TAGS.syncRuns.name],
          operationId: "requestSyncRun",
          security: SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT,
        },
      }
    )
}
