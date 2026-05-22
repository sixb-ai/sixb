import { defineInvitePolicy } from "@pario/core"
import { securityAdmins } from "../groups/security-admins"
import { teamMembers } from "../groups/team-members"

export const defaultInvites = defineInvitePolicy("default-invites", {
  grantedTo: [securityAdmins],
  canInviteTo: [teamMembers],
  canInviteWithoutGroups: true,
})
