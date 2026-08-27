import {
  CONNECTOR_CONNECTION_RUN_FAILURE_CODES,
  type ConnectorConnectionRunFailure,
} from "@sixb/core/storage"
import { z } from "zod"
import { ErrorResponseSchema, sixbFailureSchema } from "./common"

export const CONNECTOR_HTTP_ERROR_CODES = [
  "internal.unexpected",
  "connector.adapter_invalid",
  "connector.authorization_invalid",
  "connector.authorization_required",
  "connector.configuration_invalid",
  "connector.credentials_unavailable",
  "connector.not_found",
  "connector.operation_conflict",
  "connector.operation_in_progress",
  "connector.provider_failed",
  "connector.provider_unavailable",
  "connector.replacement_required",
  "connector.revocation_pending",
] as const
export type ConnectorHttpErrorCode = (typeof CONNECTOR_HTTP_ERROR_CODES)[number]

export const ConnectorBadRequestResponseSchema = connectorRouteErrorResponseSchema([
  "connector.authorization_invalid",
  "connector.configuration_invalid",
])
export const ConnectorNotFoundResponseSchema = connectorRouteErrorResponseSchema([
  "connector.not_found",
])
export const ConnectorConflictResponseSchema = connectorRouteErrorResponseSchema([
  "connector.authorization_required",
  "connector.operation_conflict",
  "connector.operation_in_progress",
  "connector.replacement_required",
  "connector.revocation_pending",
])
export const ConnectorInternalErrorResponseSchema = connectorRouteErrorResponseSchema([
  "internal.unexpected",
])
export const ConnectorBadGatewayResponseSchema = connectorRouteErrorResponseSchema([
  "connector.adapter_invalid",
  "connector.provider_failed",
])
export const ConnectorUnavailableResponseSchema = connectorRouteErrorResponseSchema([
  "connector.credentials_unavailable",
  "connector.provider_unavailable",
])

export const ConnectorParamsSchema = z.object({
  connectorId: z.string().min(1),
})

export const ConnectorConnectionParamsSchema = ConnectorParamsSchema.extend({
  connectionId: z.string().min(1),
})

export const ConnectorConnectionRunParamsSchema = ConnectorParamsSchema.extend({
  runId: z.string().min(1),
})

export const ConnectorWebhookSchema = z.object({
  id: z.string(),
  method: z.literal("POST"),
  route: z.string(),
  bodyFormat: z.enum(["json", "text", "raw"]),
  hasVerify: z.boolean(),
  hasIdempotency: z.boolean(),
})

export const ConnectorSchema = z.object({
  id: z.string(),
  type: z.string(),
  connection: z.object({ authentication: z.literal("oauth2") }).nullable(),
  syncIds: z.array(z.string()),
  webhooks: z.array(ConnectorWebhookSchema),
})

export const ConnectorAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  avatarUrl: z.string().url().optional(),
})

export const ConnectorConnectionSchema = z.object({
  id: z.string(),
  connectorId: z.string(),
  owner: z.object({ type: z.literal("project") }),
  slot: z.string(),
  account: ConnectorAccountSchema,
  status: z.enum(["connected", "needs_reauthorization", "disconnected"]),
})

const ConnectorConnectionRunFailureSchema: z.ZodType<ConnectorConnectionRunFailure> =
  sixbFailureSchema(CONNECTOR_CONNECTION_RUN_FAILURE_CODES)

const ConnectorConnectionRunBaseSchema = z.object({
  id: z.string(),
  connectorId: z.string(),
  kind: z.enum(["connect", "reauthorize"]),
  owner: z.object({ type: z.literal("project") }),
  slot: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const ConnectorConnectionRunSchema = z.union([
  ConnectorConnectionRunBaseSchema.extend({
    status: z.literal("waiting"),
    waitingFor: z.literal("provider_authorization"),
    expiresAt: z.string().datetime(),
  }),
  ConnectorConnectionRunBaseSchema.extend({
    status: z.literal("running"),
  }),
  ConnectorConnectionRunBaseSchema.extend({
    status: z.literal("waiting"),
    waitingFor: z.literal("account_selection"),
    accounts: z.array(ConnectorAccountSchema),
    expiresAt: z.string().datetime(),
  }),
  ConnectorConnectionRunBaseSchema.extend({
    status: z.literal("succeeded"),
    connections: z.array(ConnectorConnectionSchema),
    finishedAt: z.string().datetime(),
  }),
  ConnectorConnectionRunBaseSchema.extend({
    status: z.literal("failed"),
    error: ConnectorConnectionRunFailureSchema,
    finishedAt: z.string().datetime(),
  }),
  ConnectorConnectionRunBaseSchema.extend({
    status: z.enum(["cancelled", "expired"]),
    finishedAt: z.string().datetime(),
  }),
])

export const StartConnectorConnectionRunBodySchema = z.object({
  slot: z.string().trim().min(1),
  returnTo: z.string().url(),
})

export const AddConnectorConnectionBodySchema = z.object({
  slot: z.string().trim().min(1),
})

export const StartConnectorReauthorizationBodySchema = z.object({
  returnTo: z.string().url(),
})

export const StartConnectorConnectionRunResponseSchema = z.object({
  runId: z.string(),
  authorizationUrl: z.string().url(),
  affectedConnections: z.array(ConnectorConnectionSchema),
})

export const SelectConnectorConnectionRunAccountBodySchema = z.object({
  accountId: z.string().trim().min(1),
  replace: z.boolean().optional(),
})

export const ConnectorOAuthCallbackQuerySchema = z
  .object({
    state: z.string().min(1),
    code: z.string().min(1).optional(),
    auth_code: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .refine((query) => [query.code, query.auth_code, query.error].filter(Boolean).length === 1, {
    message: "OAuth callback must contain exactly one of code, auth_code, or error.",
  })
  .transform(({ auth_code, ...query }) => ({ ...query, code: query.code ?? auth_code }))

function connectorRouteErrorResponseSchema<
  const TCodes extends readonly [ConnectorHttpErrorCode, ...ConnectorHttpErrorCode[]],
>(codes: TCodes) {
  return ErrorResponseSchema.extend({
    code: z
      .enum(codes)
      .optional()
      .describe("Stable machine-readable failure code for programmatic handling."),
  })
}
