import type {
  AuthDeviceAuthorizationStore,
  CreateDeviceAuthorizationInput,
  DeviceAuthorizationRecord,
} from "@sixb/core/storage"
import { AuthStorageError, MAX_PENDING_DEVICE_AUTHORIZATIONS } from "@sixb/core/storage"
import {
  authLockKey,
  lockAdvisoryKeys,
  type PgStoreClient,
  runPgTransaction,
} from "../transactions"
import type { PgAuthDeviceAuthorizationRow } from "./rows"
import { rowToDeviceAuthorizationRecord } from "./rows"
import { assertNonEmpty, mapUniqueConstraintError } from "./shared"

export class PgAuthDeviceAuthorizationStore implements AuthDeviceAuthorizationStore {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateDeviceAuthorizationInput): Promise<DeviceAuthorizationRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      await lockAdvisoryKeys(tx, [authLockKey("device-authorizations", input.projectId)])
      await tx`
        DELETE FROM auth_device_authorizations
        WHERE project_id = ${input.projectId} AND expires_at <= ${input.createdAt}
      `
      const [pending] = await tx<{ readonly count: string | number }[]>`
        SELECT COUNT(*)::bigint AS count FROM auth_device_authorizations
        WHERE project_id = ${input.projectId} AND status = 'pending'
      `
      if (Number(pending?.count ?? 0) >= MAX_PENDING_DEVICE_AUTHORIZATIONS) {
        throw new AuthStorageError(
          "device_authorization_limit_exceeded",
          `[Sixb] Project '${input.projectId}' has too many pending device authorizations.`
        )
      }
      try {
        const [row] = await tx<PgAuthDeviceAuthorizationRow[]>`
        INSERT INTO auth_device_authorizations (
          project_id, id, device_code_hash, user_code, client_name, token_name,
          token_expires_at, status, created_at, expires_at
        ) VALUES (
          ${assertNonEmpty(input.projectId, "Project id")},
          ${assertNonEmpty(input.id, "Device authorization id")},
          ${assertNonEmpty(input.deviceCodeHash, "Device code hash")},
          ${assertNonEmpty(input.userCode, "User code")},
          ${assertNonEmpty(input.clientName, "Client name")},
          ${assertNonEmpty(input.tokenName, "Token name")},
          ${input.tokenExpiresAt}, 'pending', ${input.createdAt}, ${input.expiresAt}
        ) RETURNING *
      `
        return rowToDeviceAuthorizationRecord(row)
      } catch (error) {
        mapUniqueConstraintError(
          error,
          "duplicate_device_authorization",
          `[Sixb] Device authorization '${input.id}' already exists for project '${input.projectId}'.`
        )
      }
    })
  }

  async getById(params: { readonly projectId: string; readonly id: string }) {
    return getPgDeviceAuthorizationById(this.sql, params.projectId, params.id)
  }

  async getByUserCode(params: { readonly projectId: string; readonly userCode: string }) {
    const [row] = await this.sql<PgAuthDeviceAuthorizationRow[]>`
      SELECT * FROM auth_device_authorizations
      WHERE project_id = ${params.projectId} AND user_code = ${params.userCode}
    `
    return row ? rowToDeviceAuthorizationRecord(row) : null
  }

  async approve(params: {
    readonly projectId: string
    readonly id: string
    readonly userId: string
    readonly sessionId: string
    readonly approvedAt: Date
  }) {
    const [row] = await this.sql<PgAuthDeviceAuthorizationRow[]>`
      UPDATE auth_device_authorizations
      SET status = 'approved', approved_user_id = ${params.userId},
          approved_session_id = ${params.sessionId}, approved_at = ${params.approvedAt}
      WHERE project_id = ${params.projectId} AND id = ${params.id}
        AND status = 'pending' AND expires_at > ${params.approvedAt}
        AND EXISTS (
          SELECT 1 FROM auth_sessions
          WHERE project_id = ${params.projectId} AND id = ${params.sessionId}
            AND user_id = ${params.userId} AND revoked_at IS NULL
            AND expires_at > ${params.approvedAt}
            AND (absolute_expires_at IS NULL OR absolute_expires_at > ${params.approvedAt})
        )
      RETURNING *
    `
    if (!row) throw invalidTransition(params.id, params.projectId)
    return rowToDeviceAuthorizationRecord(row)
  }

  async deny(params: { readonly projectId: string; readonly id: string; readonly deniedAt: Date }) {
    const [row] = await this.sql<PgAuthDeviceAuthorizationRow[]>`
      UPDATE auth_device_authorizations
      SET status = 'denied', denied_at = ${params.deniedAt}
      WHERE project_id = ${params.projectId} AND id = ${params.id}
        AND status = 'pending' AND expires_at > ${params.deniedAt}
      RETURNING *
    `
    if (!row) throw invalidTransition(params.id, params.projectId)
    return rowToDeviceAuthorizationRecord(row)
  }
}

export async function getPgDeviceAuthorizationById(
  sql: PgStoreClient,
  projectId: string,
  id: string
) {
  const [row] = await sql<PgAuthDeviceAuthorizationRow[]>`
    SELECT * FROM auth_device_authorizations
    WHERE project_id = ${projectId} AND id = ${id}
  `
  return row ? rowToDeviceAuthorizationRecord(row) : null
}

function invalidTransition(id: string, projectId: string): AuthStorageError {
  return new AuthStorageError(
    "invalid_device_authorization",
    `[Sixb] Device authorization '${id}' is no longer pending for project '${projectId}'.`
  )
}
