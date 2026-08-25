import type { SixbHostView } from "@sixb/core"
import { getConnectorConnectionCallbackProcess } from "@sixb/core/internal/connector-connections"
import type { Elysia } from "elysia"
import {
  clearConnectorCallbackCookie,
  createConnectorCallbackCookie,
  readConnectorCallbackCookie,
} from "../auth/connector-callback-cookie"
import { requireRequestSixb } from "../auth/scope"
import {
  connectorRouteRuntime,
  handleConnectorRouteError,
  serializeConnectorConnection,
  serializeConnectorConnectionRun,
} from "../connectors/http"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  ConnectorBadGatewayResponseSchema,
  ConnectorBadRequestResponseSchema,
  ConnectorConflictResponseSchema,
  ConnectorConnectionParamsSchema,
  ConnectorConnectionRunParamsSchema,
  ConnectorConnectionRunSchema,
  ConnectorInternalErrorResponseSchema,
  ConnectorNotFoundResponseSchema,
  ConnectorOAuthCallbackQuerySchema,
  ConnectorUnavailableResponseSchema,
  SelectConnectorConnectionRunAccountBodySchema,
  StartConnectorConnectionRunBodySchema,
  StartConnectorConnectionRunResponseSchema,
  StartConnectorReauthorizationBodySchema,
} from "../schemas/connectors"

export interface ConnectorConnectionRouteOptions {
  readonly resolveReturnTo: (request: Request, returnTo: string) => string
  readonly resolveCallbackUrl: (request: Request) => string
}

export function registerConnectorConnectionRunRoutes(
  app: Elysia,
  host: SixbHostView,
  options: ConnectorConnectionRouteOptions
) {
  return app
    .post(
      "/api/connectors/:connectorId/connection-runs",
      async (context) => {
        const { params, body, request, set } = context
        try {
          const runtime = connectorRouteRuntime(
            host,
            requireRequestSixb(context),
            params.connectorId
          )
          const parsed = StartConnectorConnectionRunBodySchema.parse(body)
          const started = await runtime.startConnectionRun(params.connectorId, {
            owner: { type: "project" },
            slot: parsed.slot,
            returnTo: options.resolveReturnTo(request, parsed.returnTo),
            redirectUri: options.resolveCallbackUrl(request),
          })
          set.status = 201
          setResponseHeader(
            set,
            "set-cookie",
            createConnectorCallbackCookie({
              request,
              attemptId: started.callbackBinding.attemptId,
              secret: started.callbackBinding.secret,
              expiresAt: started.callbackBinding.expiresAt,
            })
          )
          return {
            runId: started.runId,
            authorizationUrl: started.authorizationUrl,
            affectedConnections: started.affectedConnections.map(serializeConnectorConnection),
          }
        } catch (error) {
          return handleConnectorRouteError(error, set)
        }
      },
      {
        params: ConnectorConnectionParamsSchema.pick({ connectorId: true }),
        body: StartConnectorConnectionRunBodySchema,
        response: {
          201: StartConnectorConnectionRunResponseSchema,
          400: ConnectorBadRequestResponseSchema,
          403: ErrorResponseSchema,
          404: ConnectorNotFoundResponseSchema,
          409: ConnectorConflictResponseSchema,
          500: ConnectorInternalErrorResponseSchema,
          502: ConnectorBadGatewayResponseSchema,
          503: ConnectorUnavailableResponseSchema,
        },
        detail: {
          summary: "Start a connector connection run",
          tags: [OPENAPI_TAGS.connectorConnectionRuns.name],
          operationId: "startConnectorConnectionRun",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/api/connectors/:connectorId/connection-runs/:runId",
      async (context) => {
        const { params, set } = context
        try {
          const runtime = connectorRouteRuntime(
            host,
            requireRequestSixb(context),
            params.connectorId
          )
          const run = await runtime.getConnectionRun(params.connectorId, params.runId)
          if (!run) {
            set.status = 404
            return { error: "Connector connection run not found" }
          }
          return serializeConnectorConnectionRun(run)
        } catch (error) {
          return handleConnectorRouteError(error, set)
        }
      },
      {
        params: ConnectorConnectionRunParamsSchema,
        response: {
          200: ConnectorConnectionRunSchema,
          400: ConnectorBadRequestResponseSchema,
          403: ErrorResponseSchema,
          404: ConnectorNotFoundResponseSchema,
          500: ConnectorInternalErrorResponseSchema,
        },
        detail: {
          summary: "Get a connector connection run",
          tags: [OPENAPI_TAGS.connectorConnectionRuns.name],
          operationId: "getConnectorConnectionRun",
        },
      }
    )
    .post(
      "/api/connectors/:connectorId/connection-runs/:runId/selection",
      async (context) => {
        const { params, body, set } = context
        try {
          const runtime = connectorRouteRuntime(
            host,
            requireRequestSixb(context),
            params.connectorId
          )
          const parsed = SelectConnectorConnectionRunAccountBodySchema.parse(body)
          const run = await runtime.selectConnectionRunAccount(params.connectorId, {
            runId: params.runId,
            accountId: parsed.accountId,
            ...(parsed.replace === undefined ? {} : { replace: parsed.replace }),
          })
          return serializeConnectorConnectionRun(run)
        } catch (error) {
          return handleConnectorRouteError(error, set)
        }
      },
      {
        params: ConnectorConnectionRunParamsSchema,
        body: SelectConnectorConnectionRunAccountBodySchema,
        response: {
          200: ConnectorConnectionRunSchema,
          400: ConnectorBadRequestResponseSchema,
          403: ErrorResponseSchema,
          404: ConnectorNotFoundResponseSchema,
          409: ConnectorConflictResponseSchema,
          500: ConnectorInternalErrorResponseSchema,
        },
        detail: {
          summary: "Select a connector account",
          tags: [OPENAPI_TAGS.connectorConnectionRuns.name],
          operationId: "selectConnectorConnectionRunAccount",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .post(
      "/api/connectors/:connectorId/connections/:connectionId/reauthorize",
      async (context) => {
        const { params, body, request, set } = context
        try {
          const runtime = connectorRouteRuntime(
            host,
            requireRequestSixb(context),
            params.connectorId
          )
          const parsed = StartConnectorReauthorizationBodySchema.parse(body)
          const started = await runtime.startReauthorization(
            params.connectorId,
            params.connectionId,
            {
              returnTo: options.resolveReturnTo(request, parsed.returnTo),
              redirectUri: options.resolveCallbackUrl(request),
            }
          )
          set.status = 201
          setResponseHeader(
            set,
            "set-cookie",
            createConnectorCallbackCookie({
              request,
              attemptId: started.callbackBinding.attemptId,
              secret: started.callbackBinding.secret,
              expiresAt: started.callbackBinding.expiresAt,
            })
          )
          return {
            runId: started.runId,
            authorizationUrl: started.authorizationUrl,
            affectedConnections: started.affectedConnections.map(serializeConnectorConnection),
          }
        } catch (error) {
          return handleConnectorRouteError(error, set)
        }
      },
      {
        params: ConnectorConnectionParamsSchema,
        body: StartConnectorReauthorizationBodySchema,
        response: {
          201: StartConnectorConnectionRunResponseSchema,
          400: ConnectorBadRequestResponseSchema,
          403: ErrorResponseSchema,
          404: ConnectorNotFoundResponseSchema,
          409: ConnectorConflictResponseSchema,
          500: ConnectorInternalErrorResponseSchema,
          502: ConnectorBadGatewayResponseSchema,
          503: ConnectorUnavailableResponseSchema,
        },
        detail: {
          summary: "Reauthorize a connector connection",
          tags: [OPENAPI_TAGS.connectorConnectionRuns.name],
          operationId: "reauthorizeConnectorConnection",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
    .get(
      "/auth/connectors/callback",
      async ({ query, request, set }) => {
        let callbackCookie: ReturnType<typeof readConnectorCallbackCookie> | undefined
        try {
          const parsed = ConnectorOAuthCallbackQuerySchema.parse(query)
          callbackCookie = readConnectorCallbackCookie(request, parsed.state)
          const result = await getConnectorConnectionCallbackProcess(host).completeConnectionRun({
            state: parsed.state,
            redirectUri: options.resolveCallbackUrl(request),
            callbackBinding: callbackCookie.value ?? "",
            ...(parsed.code === undefined ? { error: parsed.error! } : { code: parsed.code }),
          })
          return connectorCallbackRedirect(
            result.returnTo,
            result.runId,
            clearConnectorCallbackCookie(request, callbackCookie.name)
          )
        } catch (error) {
          if (callbackCookie) {
            setResponseHeader(
              set,
              "set-cookie",
              clearConnectorCallbackCookie(request, callbackCookie.name)
            )
          }
          return handleConnectorRouteError(error, set)
        }
      },
      { detail: { hide: true } }
    )
}

function connectorCallbackRedirect(returnTo: string, runId: string, clearCookie: string): Response {
  const destination = new URL(returnTo)
  destination.searchParams.set("connectionRunId", runId)
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": clearCookie,
    },
  })
}

function setResponseHeader(set: { headers?: unknown }, name: string, value: string): void {
  if (set.headers instanceof Headers) {
    set.headers.append(name, value)
    return
  }
  if (!set.headers || typeof set.headers !== "object" || Array.isArray(set.headers)) {
    set.headers = {}
  }
  ;(set.headers as Record<string, string>)[name] = value
}
