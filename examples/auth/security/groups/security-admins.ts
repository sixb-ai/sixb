import { defineGroup } from "@pario/core"

// The first bootstrap user is added to this group on sign-in (see pario.config.ts).
export const securityAdmins = defineGroup("security-admins", {
  label: "Security admins",
})
