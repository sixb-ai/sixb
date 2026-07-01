import type { Database } from "bun:sqlite"
import type {
  AuthGroupMembershipStore,
  GroupMembershipRecord,
  UpsertAuthGroupMembershipInput,
} from "@sixb/core"
import { runImmediateTransaction } from "../transactions"
import type { SqliteAuthGroupMembershipRow } from "./rows"
import { rowToGroupMembershipRecord } from "./rows"
import { listMembershipsForUser, removeGroupMembership, upsertGroupMembership } from "./shared"

export class SqliteAuthGroupMembershipStore implements AuthGroupMembershipStore {
  constructor(private readonly db: Database) {}

  async upsert(input: UpsertAuthGroupMembershipInput): Promise<GroupMembershipRecord> {
    return runImmediateTransaction(this.db, () => upsertGroupMembership(this.db, input))
  }

  async remove(params: {
    readonly projectId: string
    readonly userId: string
    readonly groupId: string
  }): Promise<GroupMembershipRecord | null> {
    return runImmediateTransaction(this.db, () => removeGroupMembership(this.db, params))
  }

  async listForUser(params: {
    readonly projectId: string
    readonly userId: string
  }): Promise<readonly GroupMembershipRecord[]> {
    return listMembershipsForUser(this.db, params)
  }

  async listForGroup(params: {
    readonly projectId: string
    readonly groupId: string
  }): Promise<readonly GroupMembershipRecord[]> {
    const rows = this.db
      .query(
        `
        SELECT *
        FROM auth_group_memberships
        WHERE project_id = ?
          AND group_id = ?
        ORDER BY user_id ASC
      `
      )
      .all(params.projectId, params.groupId) as SqliteAuthGroupMembershipRow[]

    return rows.map(rowToGroupMembershipRecord)
  }
}
