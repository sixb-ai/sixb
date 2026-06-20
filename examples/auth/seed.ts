import type { OntologySource, Sixb } from "@sixb/core"
import { AccessRequest } from "./ontology/access-request"
import { AdminNote } from "./ontology/admin-note"
import { Note } from "./ontology/note"

type SeedRuntime = Pick<Sixb<readonly OntologySource[]>, "upsertObject">

export async function seedAuthExampleObjects(sixb: SeedRuntime): Promise<void> {
  await sixb.upsertObject(Note.id, {
    id: "team-note",
    title: "Team note",
    body: "Visible to team members and security admins.",
  })

  await sixb.upsertObject(AdminNote.id, {
    id: "admin-note",
    title: "Admin note",
    body: "Visible only to security admins.",
  })

  await sixb.upsertObject(AccessRequest.id, {
    id: "access-request",
    requesterEmail: "teammate@example.com",
    reason: "Needs access to the auth example.",
    status: "pending",
  })
}
