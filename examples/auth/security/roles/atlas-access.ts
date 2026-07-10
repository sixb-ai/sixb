import { actions, applications, can, datasets, defineRole, ontology, workflows } from "@sixb/core"
import { acknowledgeNote } from "../../actions/acknowledge-note"
import { teamNotesDataset } from "../../datasets/auth-data"
import { Note } from "../../ontology/note"
import { securityAdmins } from "../groups/security-admins"
import { teamMembers } from "../groups/team-members"

export const teamMemberAtlasAccess = defineRole("team-member.atlas-access", {
  grantedTo: [teamMembers],
  grants: [
    can.access(applications.app),
    can.view(Note),
    can.view(teamNotesDataset),
    can.apply(acknowledgeNote),
  ],
})

export const securityAdminFullAccess = defineRole("security-admin.full-access", {
  grantedTo: [securityAdmins],
  grants: [
    can.access([applications.atlas, applications.app]),
    can.view(ontology.objects()),
    can.view(datasets()),
    can.apply(actions()),
    can.run(workflows()),
    can.observe("logs"),
  ],
})
