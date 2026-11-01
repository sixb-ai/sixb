import { defineMembershipPolicy } from "@sixb/core"
import { localAdmins } from "../groups/local-admins"

// Local only: lets local admins manage each other, so Members and Service accounts show.
export const localMembers = defineMembershipPolicy("local-members", {
  grantedTo: [localAdmins],
  scope: [localAdmins],
  can: ["invite", "assignGroups", "suspend", "serviceAccounts"],
})
