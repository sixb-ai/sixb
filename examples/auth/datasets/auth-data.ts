import { col, defineDataset } from "@sixb/core"

export const teamNotesDataset = defineDataset("auth.team_notes", {
  schema: [col("id", "string"), col("title", "string"), col("ownerEmail", "string")],
})

export const adminAuditDataset = defineDataset("auth.admin_audit", {
  schema: [col("id", "string"), col("actorEmail", "string"), col("event", "string")],
})
