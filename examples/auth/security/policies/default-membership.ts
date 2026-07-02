import { defineMembershipPolicy } from "@sixb/core"
import { securityAdmins } from "../groups/security-admins"
import { teamMembers } from "../groups/team-members"

// Security admins can invite, group, suspend, and reactivate example users.
// Group-less users can sign in but receive no role grants until assigned a group.
export const memberAdministration = defineMembershipPolicy("member-administration", {
  grantedTo: [securityAdmins],
  scope: [securityAdmins, teamMembers],
  can: ["invite", "assignGroups", "suspend"],
})
