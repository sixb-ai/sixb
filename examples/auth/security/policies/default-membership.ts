import { defineMembershipPolicy } from "@sixb/core"
import { securityAdmins } from "../groups/security-admins"
import { teamMembers } from "../groups/team-members"

// Security admins can invite new people into the team-members group.
export const defaultMembership = defineMembershipPolicy("default-membership", {
  grantedTo: [securityAdmins],
  scope: [teamMembers],
  can: ["invite"],
})
