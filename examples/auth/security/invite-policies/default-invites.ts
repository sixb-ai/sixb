import { defineInvitePolicy } from "@sixb/core"
import { securityAdmins } from "../groups/security-admins"
import { teamMembers } from "../groups/team-members"

// Security admins can invite new people into the team-members group.
export const defaultInvites = defineInvitePolicy("default-invites", {
  grantedTo: [securityAdmins],
  canInviteTo: [teamMembers],
  canInviteWithoutGroups: true,
})
