import type { Database } from "bun:sqlite"
import type {
  AuthDeviceAuthorizationStore,
  CreateDeviceAuthorizationInput,
  DeviceAuthorizationRecord,
} from "@sixb/core/storage"
import { AuthStorageError, MAX_PENDING_DEVICE_AUTHORIZATIONS } from "@sixb/core/storage"
import { runImmediateTransaction } from "../transactions"
import type { SqliteAuthDeviceAuthorizationRow } from "./rows"
import { rowToDeviceAuthorizationRecord } from "./rows"
import { assertNonEmpty, mapUniqueConstraintError, toIso } from "./shared"

export class SqliteAuthDeviceAuthorizationStore implements AuthDeviceAuthorizationStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateDeviceAuthorizationInput): Promise<DeviceAuthorizationRecord> {
    return runImmediateTransaction(this.db, () => {
      this.db
        .query("DELETE FROM auth_device_authorizations WHERE project_id = ? AND expires_at <= ?")
        .run(input.projectId, toIso(input.createdAt))
      const pending = this.db
        .query(
          "SELECT COUNT(*) AS count FROM auth_device_authorizations WHERE project_id = ? AND status = 'pending'"
        )
        .get(input.projectId) as { readonly count: number }
      if (pending.count >= MAX_PENDING_DEVICE_AUTHORIZATIONS) {
        throw new AuthStorageError(
          "device_authorization_limit_exceeded",
          `[Sixb] Project '${input.projectId}' has too many pending device authorizations.`
        )
      }
      try {
        this.db
          .query(`
          INSERT INTO auth_device_authorizations (
            project_id, id, device_code_hash, user_code, client_name, token_name,
            token_expires_at, status, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `)
          .run(
            assertNonEmpty(input.projectId, "Project id"),
            assertNonEmpty(input.id, "Device authorization id"),
            assertNonEmpty(input.deviceCodeHash, "Device code hash"),
            assertNonEmpty(input.userCode, "User code"),
            assertNonEmpty(input.clientName, "Client name"),
            assertNonEmpty(input.tokenName, "Token name"),
            toIso(input.tokenExpiresAt),
            toIso(input.createdAt),
            toIso(input.expiresAt)
          )
      } catch (error) {
        mapUniqueConstraintError(
          error,
          "duplicate_device_authorization",
          `[Sixb] Device authorization '${input.id}' already exists for project '${input.projectId}'.`
        )
      }
      return requireById(this.db, input.projectId, input.id)
    })
  }

  async getById(params: { readonly projectId: string; readonly id: string }) {
    return getById(this.db, params.projectId, params.id)
  }

  async getByUserCode(params: { readonly projectId: string; readonly userCode: string }) {
    const row = this.db
      .query("SELECT * FROM auth_device_authorizations WHERE project_id = ? AND user_code = ?")
      .get(params.projectId, params.userCode) as SqliteAuthDeviceAuthorizationRow | null
    return row ? rowToDeviceAuthorizationRecord(row) : null
  }

  async approve(params: {
    readonly projectId: string
    readonly id: string
    readonly userId: string
    readonly sessionId: string
    readonly approvedAt: Date
  }) {
    return runImmediateTransaction(this.db, () => {
      const result = this.db
        .query(`
        UPDATE auth_device_authorizations
        SET status = 'approved', approved_user_id = ?, approved_session_id = ?, approved_at = ?
        WHERE project_id = ? AND id = ? AND status = 'pending' AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM auth_sessions
            WHERE project_id = ? AND id = ? AND user_id = ?
              AND revoked_at IS NULL AND expires_at > ?
              AND (absolute_expires_at IS NULL OR absolute_expires_at > ?)
          )
      `)
        .run(
          params.userId,
          params.sessionId,
          toIso(params.approvedAt),
          params.projectId,
          params.id,
          toIso(params.approvedAt),
          params.projectId,
          params.sessionId,
          params.userId,
          toIso(params.approvedAt),
          toIso(params.approvedAt)
        )
      if (result.changes !== 1) throw invalidTransition(params.id, params.projectId)
      return requireById(this.db, params.projectId, params.id)
    })
  }

  async deny(params: { readonly projectId: string; readonly id: string; readonly deniedAt: Date }) {
    return runImmediateTransaction(this.db, () => {
      const result = this.db
        .query(`
        UPDATE auth_device_authorizations
        SET status = 'denied', denied_at = ?
        WHERE project_id = ? AND id = ? AND status = 'pending' AND expires_at > ?
      `)
        .run(toIso(params.deniedAt), params.projectId, params.id, toIso(params.deniedAt))
      if (result.changes !== 1) throw invalidTransition(params.id, params.projectId)
      return requireById(this.db, params.projectId, params.id)
    })
  }
}

export function getDeviceAuthorizationById(db: Database, projectId: string, id: string) {
  return getById(db, projectId, id)
}

function getById(db: Database, projectId: string, id: string) {
  const row = db
    .query("SELECT * FROM auth_device_authorizations WHERE project_id = ? AND id = ?")
    .get(projectId, id) as SqliteAuthDeviceAuthorizationRow | null
  return row ? rowToDeviceAuthorizationRecord(row) : null
}

function requireById(db: Database, projectId: string, id: string): DeviceAuthorizationRecord {
  const record = getById(db, projectId, id)
  if (!record) {
    throw new AuthStorageError(
      "missing_device_authorization",
      `[Sixb] Device authorization '${id}' not found for project '${projectId}'.`
    )
  }
  return record
}

function invalidTransition(id: string, projectId: string): AuthStorageError {
  return new AuthStorageError(
    "invalid_device_authorization",
    `[Sixb] Device authorization '${id}' is no longer pending for project '${projectId}'.`
  )
}
