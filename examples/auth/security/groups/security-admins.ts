import { defineGroup } from "@sixb/core"

// The first bootstrap user is added to this group on sign-in (see sixb.config.ts).
export const securityAdmins = defineGroup("security-admins", {
  label: "Security admins",
})
