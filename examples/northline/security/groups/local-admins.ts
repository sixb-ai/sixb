import { defineGroup } from "@sixb/core"

// Local only: who can see everything when Northline runs with NORTHLINE_AUTH=magic-link.
export const localAdmins = defineGroup("local-admins", { label: "Local admins" })
