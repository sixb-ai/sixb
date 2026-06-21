import type { Database } from "bun:sqlite"
import type {
  AuthServiceAccountGroupMembershipStore,
  ServiceAccountGroupMembershipRecord,
  UpsertAuthServiceAccountGroupMembershipInput,
} from "@sixb/core"
import { AuthStorageError } from "@sixb/core"
import type {
  SqliteAuthServiceAccountGroupMembershipRow,
  SqliteAuthServiceAccountRow,
} from "./rows"
import { rowToServiceAccountGroupMembershipRecord } from "./rows"
import { assertNonEmpty, dateOrNow, toIso } from "./shared"

export class SqliteAuthServiceAccountGroupMembershipStore
  implements AuthServiceAccountGroupMembershipStore
{
  constructor(private readonly db: Database) {}

  async upsert(
    input: UpsertAuthServiceAccountGroupMembershipInput
  ): Promise<ServiceAccountGroupMembershipRecord> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const serviceAccountId = assertNonEmpty(input.serviceAccountId, "Service account id")
    const groupId = assertNonEmpty(input.groupId, "Group id")
    const serviceAccount = this.db
      .query("SELECT * FROM auth_service_accounts WHERE project_id = ? AND id = ?")
      .get(projectId, serviceAccountId) as SqliteAuthServiceAccountRow | null
    if (!serviceAccount) {
      throw new AuthStorageError(
        "missing_service_account",
        `[Sixb] Service account '${serviceAccountId}' not found for project '${projectId}'.`
      )
    }

    this.db
      .query(
        `
        INSERT OR IGNORE INTO auth_service_account_group_memberships (
          project_id,
          service_account_id,
          group_id,
          source,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(projectId, serviceAccountId, groupId, input.source, toIso(dateOrNow(input.createdAt)))

    const row = this.db
      .query(
        `
        SELECT *
        FROM auth_service_account_group_memberships
        WHERE project_id = ?
          AND service_account_id = ?
          AND group_id = ?
      `
      )
      .get(projectId, serviceAccountId, groupId) as SqliteAuthServiceAccountGroupMembershipRow
    return rowToServiceAccountGroupMembershipRecord(row)
  }

  async listForServiceAccount(params: {
    readonly projectId: string
    readonly serviceAccountId: string
  }): Promise<readonly ServiceAccountGroupMembershipRecord[]> {
    const rows = this.db
      .query(
        `
        SELECT *
        FROM auth_service_account_group_memberships
        WHERE project_id = ?
          AND service_account_id = ?
        ORDER BY group_id ASC
      `
      )
      .all(
        params.projectId,
        params.serviceAccountId
      ) as SqliteAuthServiceAccountGroupMembershipRow[]

    return rows.map(rowToServiceAccountGroupMembershipRecord)
  }

  async listForGroup(params: {
    readonly projectId: string
    readonly groupId: string
  }): Promise<readonly ServiceAccountGroupMembershipRecord[]> {
    const rows = this.db
      .query(
        `
        SELECT *
        FROM auth_service_account_group_memberships
        WHERE project_id = ?
          AND group_id = ?
        ORDER BY service_account_id ASC
      `
      )
      .all(params.projectId, params.groupId) as SqliteAuthServiceAccountGroupMembershipRow[]

    return rows.map(rowToServiceAccountGroupMembershipRecord)
  }
}
