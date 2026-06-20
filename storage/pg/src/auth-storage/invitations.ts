import type {
  AuthInvitationStore,
  CreateOrUpdateAuthInvitationInput,
  InvitationRecord,
  ListAuthInvitationsInput,
  ListAuthInvitationsResult,
} from "@sixb/core"
import { AuthStorageError } from "@sixb/core"
import type { SQLClient } from "../pg-client"
import {
  authLockKey,
  lockAdvisoryKeys,
  type PgStoreClient,
  runPgTransaction,
} from "../transactions"
import type { PgAuthInvitationRow } from "./rows"
import { rowToInvitationRecord } from "./rows"
import {
  appendPagination,
  assertNonEmpty,
  dateOrNow,
  getActiveInvitationByEmail,
  getInvitationById,
  getInvitationGroupIds,
  hasEmptyFilter,
  invitationCreatorColumns,
  mapUniqueConstraintError,
  normalizeEmail,
  normalizeGroupIds,
  type PgValue,
  placeholders,
  replaceInvitationGroups,
  requireInvitationById,
  requireSessionById,
  requireUserById,
} from "./shared"

export class PgAuthInvitationStore implements AuthInvitationStore {
  constructor(private readonly sql: PgStoreClient) {}

  async createOrUpdateActive(input: CreateOrUpdateAuthInvitationInput): Promise<InvitationRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const id = assertNonEmpty(input.id, "Invitation id")
      const projectId = assertNonEmpty(input.projectId, "Project id")
      const email = normalizeEmail(input.email)
      const groupIds = normalizeGroupIds(input.groupIds)
      const now = dateOrNow(input.updatedAt ?? input.createdAt)
      const creator = invitationCreatorColumns(input.createdByPrincipal)

      await lockAdvisoryKeys(tx, [authLockKey("invitations", projectId, email)])
      await this.validateCreator(tx, projectId, input)

      const existingActive = await getActiveInvitationByEmail(
        tx,
        {
          projectId,
          email,
          now,
        },
        { forUpdate: true }
      )

      if (existingActive) {
        await tx`
          UPDATE auth_invitations
          SET created_by_user_id = ${creator.createdByUserId},
              created_by_service_account_id = ${creator.createdByServiceAccountId},
              created_by_system_id = ${creator.createdBySystemId},
              created_by_session_id = ${input.createdBySessionId ?? null},
              expires_at = ${input.expiresAt},
              updated_at = ${now}
          WHERE project_id = ${projectId}
            AND id = ${existingActive.id}
        `
        await replaceInvitationGroups(tx, {
          projectId,
          invitationId: existingActive.id,
          groupIds,
        })

        return requireInvitationById(tx, { projectId, id: existingActive.id })
      }

      if (await getInvitationById(tx, { projectId, id })) {
        throw new AuthStorageError(
          "duplicate_invitation",
          `[Sixb] Invitation '${id}' already exists but is not active for project '${projectId}'.`
        )
      }

      const createdAt = dateOrNow(input.createdAt)
      try {
        await tx`
          INSERT INTO auth_invitations (
            project_id,
            id,
            email,
            status,
            created_by_user_id,
            created_by_service_account_id,
            created_by_system_id,
            created_by_session_id,
            created_at,
            updated_at,
            expires_at
          ) VALUES (
            ${projectId},
            ${id},
            ${email},
            ${"pending"},
            ${creator.createdByUserId},
            ${creator.createdByServiceAccountId},
            ${creator.createdBySystemId},
            ${input.createdBySessionId ?? null},
            ${createdAt},
            ${now},
            ${input.expiresAt}
          )
        `
      } catch (error) {
        mapUniqueConstraintError(
          error,
          "duplicate_invitation",
          `[Sixb] Invitation '${id}' already exists for project '${projectId}'.`
        )
      }

      await replaceInvitationGroups(tx, { projectId, invitationId: id, groupIds })
      return requireInvitationById(tx, { projectId, id })
    })
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<InvitationRecord | null> {
    return getInvitationById(this.sql, params)
  }

  async getActiveByEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly now: Date
  }): Promise<InvitationRecord | null> {
    return getActiveInvitationByEmail(this.sql, params)
  }

  async list(input: ListAuthInvitationsInput): Promise<ListAuthInvitationsResult> {
    if (hasEmptyFilter(input.statuses) || hasEmptyFilter(input.groupIds)) {
      return { invitations: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = $1"]
    const params: PgValue[] = [input.projectId]
    let nextIndex = 2

    if (input.email) {
      whereClauses.push(`email = $${nextIndex++}`)
      params.push(normalizeEmail(input.email))
    }

    if (input.statuses) {
      const statusPlaceholders = placeholders(nextIndex, input.statuses.length)
      nextIndex += input.statuses.length
      whereClauses.push(`status IN (${statusPlaceholders.join(", ")})`)
      params.push(...input.statuses)
    }

    const groupIds = input.groupIds ? normalizeGroupIds(input.groupIds) : null
    if (groupIds) {
      const groupPlaceholders = placeholders(nextIndex, groupIds.length)
      nextIndex += groupIds.length
      whereClauses.push(`
        EXISTS (
          SELECT 1
          FROM auth_invitation_groups invitation_groups
          WHERE invitation_groups.project_id = auth_invitations.project_id
            AND invitation_groups.invitation_id = auth_invitations.id
            AND invitation_groups.group_id IN (${groupPlaceholders.join(", ")})
        )
      `)
      params.push(...groupIds)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const [totalRow] = await this.sql.unsafe<{ readonly count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM auth_invitations ${where}`,
      [...params]
    )

    const queryParams = [...params]
    const query = appendPagination(
      `
        SELECT *
        FROM auth_invitations
        ${where}
        ORDER BY created_at ${order}, id ${order}
      `,
      queryParams,
      nextIndex,
      input
    )
    const rows = await this.sql.unsafe<PgAuthInvitationRow[]>(query, queryParams)
    const invitations = await Promise.all(
      rows.map(async (row) =>
        rowToInvitationRecord(
          row,
          await getInvitationGroupIds(this.sql, {
            projectId: row.project_id,
            invitationId: row.id,
          })
        )
      )
    )
    const total = Number(totalRow?.count ?? 0)

    return {
      invitations,
      hasMore: (input.offset ?? 0) + rows.length < total,
      total,
    }
  }

  async accept(params: {
    readonly projectId: string
    readonly id: string
    readonly acceptedAt: Date
  }): Promise<InvitationRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      await requireInvitationById(tx, params, { forUpdate: true })

      await tx`
        UPDATE auth_invitations
        SET status = 'accepted',
            accepted_at = ${params.acceptedAt},
            updated_at = ${params.acceptedAt}
        WHERE project_id = ${params.projectId}
          AND id = ${params.id}
      `

      return requireInvitationById(tx, params)
    })
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<InvitationRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      await requireInvitationById(tx, params, { forUpdate: true })

      await tx`
        UPDATE auth_invitations
        SET status = 'revoked',
            revoked_at = ${params.revokedAt},
            updated_at = ${params.revokedAt}
        WHERE project_id = ${params.projectId}
          AND id = ${params.id}
      `

      return requireInvitationById(tx, params)
    })
  }

  private async validateCreator(
    sql: SQLClient,
    projectId: string,
    input: CreateOrUpdateAuthInvitationInput
  ): Promise<void> {
    if (input.createdByPrincipal?.type === "user") {
      await requireUserById(sql, { projectId, id: input.createdByPrincipal.id })
    }

    if (input.createdBySessionId) {
      await requireSessionById(sql, { projectId, id: input.createdBySessionId })
    }
  }
}
