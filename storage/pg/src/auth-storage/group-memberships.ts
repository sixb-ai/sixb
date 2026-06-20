import type {
  AuthGroupMembershipStore,
  GroupMembershipRecord,
  UpsertAuthGroupMembershipInput,
} from "@sixb/core"
import type { PgStoreClient } from "../transactions"
import type { PgAuthGroupMembershipRow } from "./rows"
import { rowToGroupMembershipRecord } from "./rows"
import { listMembershipsForUser, upsertGroupMembership } from "./shared"

export class PgAuthGroupMembershipStore implements AuthGroupMembershipStore {
  constructor(private readonly sql: PgStoreClient) {}

  async upsert(input: UpsertAuthGroupMembershipInput): Promise<GroupMembershipRecord> {
    return upsertGroupMembership(this.sql, input)
  }

  async listForUser(params: {
    readonly projectId: string
    readonly userId: string
  }): Promise<readonly GroupMembershipRecord[]> {
    return listMembershipsForUser(this.sql, params)
  }

  async listForGroup(params: {
    readonly projectId: string
    readonly groupId: string
  }): Promise<readonly GroupMembershipRecord[]> {
    const rows = await this.sql<PgAuthGroupMembershipRow[]>`
      SELECT *
      FROM auth_group_memberships
      WHERE project_id = ${params.projectId}
        AND group_id = ${params.groupId}
      ORDER BY user_id ASC
    `

    return rows.map(rowToGroupMembershipRecord)
  }
}
