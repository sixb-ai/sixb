import { actions, can, defineRole, ontology, workflows } from "@sixb/core"
import { acknowledgeNote } from "../../actions/acknowledge-note"
import { Note } from "../../ontology/note"
import { securityAdmins } from "../groups/security-admins"
import { teamMembers } from "../groups/team-members"

export const teamMemberAtlasAccess = defineRole("team-member.atlas-access", {
  grantedTo: [teamMembers],
  grants: [can.view(Note), can.apply(acknowledgeNote)],
})

export const securityAdminFullAccess = defineRole("security-admin.full-access", {
  grantedTo: [securityAdmins],
  grants: [can.view(ontology.objects()), can.apply(actions()), can.run(workflows())],
})
