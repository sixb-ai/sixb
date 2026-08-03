import type { Database } from "bun:sqlite"
import type {
  AuthInvitationStore,
  CreateOrUpdateAuthInvitationInput,
  InvitationRecord,
  ListAuthInvitationsInput,
  ListAuthInvitationsResult,
} from "@sixb/core/storage"
import { authStorageError } from "@sixb/core/storage"
import { runImmediateTransaction } from "../transactions"
import type { SqliteAuthInvitationRow } from "./rows"
import { rowToInvitationRecord } from "./rows"
import {
  appendPagination,
  assertNonEmpty,
  dateOrNow,
  getActiveInvitationByEmail,
  getInvitationById,
  getInvitationGroupIds,
  hasEmptyFilter,
  mapUniqueConstraintError,
  normalizeEmail,
  normalizeGroupIds,
  replaceInvitationGroups,
  requireInvitationById,
  type SqliteValue,
  toIso,
} from "./shared"

export class SqliteAuthInvitationStore implements AuthInvitationStore {
  constructor(private readonly db: Database) {}

  async createOrUpdateActive(input: CreateOrUpdateAuthInvitationInput): Promise<InvitationRecord> {
    return runImmediateTransaction(this.db, () => {
      const id = assertNonEmpty(input.id, "Invitation id")
      const projectId = assertNonEmpty(input.projectId, "Project id")
      const email = normalizeEmail(input.email)
      const groupIds = normalizeGroupIds(input.groupIds)
      const now = dateOrNow(input.updatedAt ?? input.createdAt)
      const existingActive = getActiveInvitationByEmail(this.db, {
        projectId,
        email,
        now,
      })

      if (existingActive) {
        this.db
          .query(
            `
            UPDATE auth_invitations
            SET created_by_principal_type = ?,
                created_by_principal_id = ?,
                created_by_session_id = ?,
                expires_at = ?,
                updated_at = ?
            WHERE project_id = ?
              AND id = ?
          `
          )
          .run(
            input.createdByPrincipal?.type ?? null,
            input.createdByPrincipal?.id ?? null,
            input.createdBySessionId ?? null,
            toIso(input.expiresAt),
            toIso(now),
            projectId,
            existingActive.id
          )
        replaceInvitationGroups(this.db, {
          projectId,
          invitationId: existingActive.id,
          groupIds,
        })

        return requireInvitationById(this.db, { projectId, id: existingActive.id })
      }

      if (getInvitationById(this.db, { projectId, id })) {
        throw authStorageError(
          "duplicate_invitation",
          `[Sixb] Invitation '${id}' already exists but is not active for project '${projectId}'.`
        )
      }

      const createdAt = dateOrNow(input.createdAt)
      try {
        this.db
          .query(
            `
            INSERT INTO auth_invitations (
              project_id,
              id,
              email,
              status,
              created_by_principal_type,
              created_by_principal_id,
              created_by_session_id,
              created_at,
              updated_at,
              expires_at
            ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
          `
          )
          .run(
            projectId,
            id,
            email,
            input.createdByPrincipal?.type ?? null,
            input.createdByPrincipal?.id ?? null,
            input.createdBySessionId ?? null,
            toIso(createdAt),
            toIso(now),
            toIso(input.expiresAt)
          )
      } catch (error) {
        mapUniqueConstraintError(
          error,
          "duplicate_invitation",
          `[Sixb] Invitation '${id}' already exists for project '${projectId}'.`
        )
      }

      replaceInvitationGroups(this.db, { projectId, invitationId: id, groupIds })
      return requireInvitationById(this.db, { projectId, id })
    })
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<InvitationRecord | null> {
    return getInvitationById(this.db, params)
  }

  async getActiveByEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly now: Date
  }): Promise<InvitationRecord | null> {
    return getActiveInvitationByEmail(this.db, params)
  }

  async list(input: ListAuthInvitationsInput): Promise<ListAuthInvitationsResult> {
    if (hasEmptyFilter(input.statuses) || hasEmptyFilter(input.groupIds)) {
      return { invitations: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.email) {
      whereClauses.push("email = ?")
      args.push(normalizeEmail(input.email))
    }

    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
      args.push(...input.statuses)
    }

    const groupIds = input.groupIds ? normalizeGroupIds(input.groupIds) : null
    if (groupIds) {
      whereClauses.push(`
        EXISTS (
          SELECT 1
          FROM auth_invitation_groups invitation_groups
          WHERE invitation_groups.project_id = auth_invitations.project_id
            AND invitation_groups.invitation_id = auth_invitations.id
            AND invitation_groups.group_id IN (${groupIds.map(() => "?").join(", ")})
        )
      `)
      args.push(...groupIds)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM auth_invitations ${where}`)
      .get(...args) as { readonly count: number }

    const queryArgs = [...args]
    const query = appendPagination(
      `
      SELECT *
      FROM auth_invitations
      ${where}
      ORDER BY created_at ${order}, id ${order}
    `,
      queryArgs,
      input
    )
    const rows = this.db.query(query).all(...queryArgs) as SqliteAuthInvitationRow[]

    return {
      invitations: rows.map((row) =>
        rowToInvitationRecord(
          row,
          getInvitationGroupIds(this.db, {
            projectId: row.project_id,
            invitationId: row.id,
          })
        )
      ),
      hasMore: (input.offset ?? 0) + rows.length < totalRow.count,
      total: totalRow.count,
    }
  }

  async accept(params: {
    readonly projectId: string
    readonly id: string
    readonly acceptedAt: Date
  }): Promise<InvitationRecord> {
    return runImmediateTransaction(this.db, () => {
      requireInvitationById(this.db, params)

      this.db
        .query(
          `
          UPDATE auth_invitations
          SET status = 'accepted',
              accepted_at = ?,
              updated_at = ?
          WHERE project_id = ?
            AND id = ?
        `
        )
        .run(toIso(params.acceptedAt), toIso(params.acceptedAt), params.projectId, params.id)

      return requireInvitationById(this.db, params)
    })
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<InvitationRecord> {
    return runImmediateTransaction(this.db, () => {
      requireInvitationById(this.db, params)

      this.db
        .query(
          `
          UPDATE auth_invitations
          SET status = 'revoked',
              revoked_at = ?,
              updated_at = ?
          WHERE project_id = ?
            AND id = ?
        `
        )
        .run(toIso(params.revokedAt), toIso(params.revokedAt), params.projectId, params.id)

      return requireInvitationById(this.db, params)
    })
  }
}
