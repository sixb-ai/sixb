import type { OntologySource, Sixb } from "@sixb/core"
import { AccessRequest } from "./ontology/access-request"
import { AdminNote } from "./ontology/admin-note"
import { Note } from "./ontology/note"

type SeedRuntime = {
  readonly objects: Pick<Sixb<readonly OntologySource[]>["objects"], "upsert">
}

export async function seedAuthExampleObjects(sixb: SeedRuntime): Promise<void> {
  await sixb.objects.upsert(Note.id, {
    id: "team-note",
    title: "Team note",
    body: "Visible to team members and security admins.",
  })

  await sixb.objects.upsert(AdminNote.id, {
    id: "admin-note",
    title: "Admin note",
    body: "Visible only to security admins.",
  })

  await sixb.objects.upsert(AccessRequest.id, {
    id: "access-request",
    requesterEmail: "teammate@example.com",
    reason: "Needs access to the auth example.",
    status: "pending",
  })
}
