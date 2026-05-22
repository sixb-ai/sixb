import type {
  AuthGroupMembershipStore,
  GroupMembershipRecord,
  UpsertAuthGroupMembershipInput,
} from "@pario/core"
import type { SQL } from "bun"
import type { PgAuthGroupMembershipRow } from "./rows"
import { rowToGroupMembershipRecord } from "./rows"
import { listMembershipsForUser, upsertGroupMembership } from "./shared"

export class PgAuthGroupMembershipStore implements AuthGroupMembershipStore {
  constructor(private readonly sql: SQL) {}

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
    const rows = (await this.sql`
      SELECT *
      FROM auth_group_memberships
      WHERE project_id = ${params.projectId}
        AND group_id = ${params.groupId}
      ORDER BY user_id ASC
    `) as PgAuthGroupMembershipRow[]

    return rows.map(rowToGroupMembershipRecord)
  }
}
