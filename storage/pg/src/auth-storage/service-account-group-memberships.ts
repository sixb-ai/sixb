import type {
  AuthServiceAccountGroupMembershipStore,
  ReconcileAuthServiceAccountGroupMembershipsInput,
  ServiceAccountGroupMembershipRecord,
  UpsertAuthServiceAccountGroupMembershipInput,
} from "@sixb/core/storage"
import { authStorageError } from "@sixb/core/storage"
import type { PgStoreClient } from "../transactions"
import type { PgAuthServiceAccountGroupMembershipRow, PgAuthServiceAccountRow } from "./rows"
import { rowToServiceAccountGroupMembershipRecord } from "./rows"
import { assertNonEmpty, dateOrNow } from "./shared"

export class PgAuthServiceAccountGroupMembershipStore
  implements AuthServiceAccountGroupMembershipStore
{
  constructor(private readonly sql: PgStoreClient) {}

  async upsert(
    input: UpsertAuthServiceAccountGroupMembershipInput
  ): Promise<ServiceAccountGroupMembershipRecord> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const serviceAccountId = assertNonEmpty(input.serviceAccountId, "Service account id")
    const groupId = assertNonEmpty(input.groupId, "Group id")
    const [serviceAccount] = await this.sql<PgAuthServiceAccountRow[]>`
      SELECT *
      FROM auth_service_accounts
      WHERE project_id = ${projectId}
        AND id = ${serviceAccountId}
    `
    if (!serviceAccount) {
      throw authStorageError(
        "missing_service_account",
        `[Sixb] Service account '${serviceAccountId}' not found for project '${projectId}'.`
      )
    }

    const [row] = await this.sql<PgAuthServiceAccountGroupMembershipRow[]>`
      INSERT INTO auth_service_account_group_memberships (
        project_id,
        service_account_id,
        group_id,
        source,
        created_at
      ) VALUES (
        ${projectId},
        ${serviceAccountId},
        ${groupId},
        ${input.source},
        ${dateOrNow(input.createdAt)}
      )
      ON CONFLICT (project_id, service_account_id, group_id) DO UPDATE
      SET source = auth_service_account_group_memberships.source
      RETURNING *
    `

    return rowToServiceAccountGroupMembershipRecord(row)
  }

  async reconcileForServiceAccount(
    input: ReconcileAuthServiceAccountGroupMembershipsInput
  ): Promise<readonly ServiceAccountGroupMembershipRecord[]> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const serviceAccountId = assertNonEmpty(input.serviceAccountId, "Service account id")
    const groupIds = [
      ...new Set(input.groupIds.map((groupId) => assertNonEmpty(groupId, "Group id"))),
    ]
    const [serviceAccount] = await this.sql<PgAuthServiceAccountRow[]>`
      SELECT *
      FROM auth_service_accounts
      WHERE project_id = ${projectId}
        AND id = ${serviceAccountId}
    `
    if (!serviceAccount) {
      throw authStorageError(
        "missing_service_account",
        `[Sixb] Service account '${serviceAccountId}' not found for project '${projectId}'.`
      )
    }

    if (groupIds.length === 0) {
      await this.sql`
        DELETE FROM auth_service_account_group_memberships
        WHERE project_id = ${projectId}
          AND service_account_id = ${serviceAccountId}
          AND source = ${input.source}
      `
    } else {
      await this.sql`
        DELETE FROM auth_service_account_group_memberships
        WHERE project_id = ${projectId}
          AND service_account_id = ${serviceAccountId}
          AND source = ${input.source}
          AND group_id NOT IN ${this.sql(groupIds)}
      `
    }

    const updatedAt = dateOrNow(input.updatedAt)
    for (const groupId of groupIds) {
      await this.sql<PgAuthServiceAccountGroupMembershipRow[]>`
        INSERT INTO auth_service_account_group_memberships (
          project_id,
          service_account_id,
          group_id,
          source,
          created_at
        ) VALUES (
          ${projectId},
          ${serviceAccountId},
          ${groupId},
          ${input.source},
          ${updatedAt}
        )
        ON CONFLICT (project_id, service_account_id, group_id) DO UPDATE
        SET source = EXCLUDED.source
      `
    }

    return this.listForServiceAccount({ projectId, serviceAccountId })
  }

  async listForServiceAccount(params: {
    readonly projectId: string
    readonly serviceAccountId: string
  }): Promise<readonly ServiceAccountGroupMembershipRecord[]> {
    const rows = await this.sql<PgAuthServiceAccountGroupMembershipRow[]>`
      SELECT *
      FROM auth_service_account_group_memberships
      WHERE project_id = ${params.projectId}
        AND service_account_id = ${params.serviceAccountId}
      ORDER BY group_id ASC
    `

    return rows.map(rowToServiceAccountGroupMembershipRecord)
  }

  async listForGroup(params: {
    readonly projectId: string
    readonly groupId: string
  }): Promise<readonly ServiceAccountGroupMembershipRecord[]> {
    const rows = await this.sql<PgAuthServiceAccountGroupMembershipRow[]>`
      SELECT *
      FROM auth_service_account_group_memberships
      WHERE project_id = ${params.projectId}
        AND group_id = ${params.groupId}
      ORDER BY service_account_id ASC
    `

    return rows.map(rowToServiceAccountGroupMembershipRecord)
  }
}
