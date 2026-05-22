import type {
  AuthGroupMembershipStore,
  GroupMembershipRecord,
  UpsertAuthGroupMembershipInput,
} from "../types"
import type { AuthStorageState } from "./shared"
import { cloneRecord, upsertGroupMembershipRecord } from "./shared"

export class InMemoryAuthGroupMembershipStore implements AuthGroupMembershipStore {
  constructor(private readonly state: AuthStorageState) {}

  async upsert(input: UpsertAuthGroupMembershipInput): Promise<GroupMembershipRecord> {
    return cloneRecord(upsertGroupMembershipRecord(this.state, input))
  }

  async listForUser(params: {
    readonly projectId: string
    readonly userId: string
  }): Promise<readonly GroupMembershipRecord[]> {
    return [...this.state.groupMemberships.values()]
      .filter((membership) => membership.projectId === params.projectId)
      .filter((membership) => membership.userId === params.userId)
      .sort((a, b) => a.groupId.localeCompare(b.groupId))
      .map(cloneRecord)
  }

  async listForGroup(params: {
    readonly projectId: string
    readonly groupId: string
  }): Promise<readonly GroupMembershipRecord[]> {
    return [...this.state.groupMemberships.values()]
      .filter((membership) => membership.projectId === params.projectId)
      .filter((membership) => membership.groupId === params.groupId)
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .map(cloneRecord)
  }
}
