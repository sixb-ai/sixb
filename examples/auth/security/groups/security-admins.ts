import { defineGroup } from "@sixb/core/security"

// The first bootstrap user is added to this group on sign-in (see sixb.config.ts).
export const securityAdmins = defineGroup("security-admins", {
  label: "Security admins",
})
