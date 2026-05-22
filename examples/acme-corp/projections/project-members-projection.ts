import { defineLinkProjection } from "@pario/core"
import { erpProjectMembersDataset } from "../datasets/erp"
import { Project } from "../ontology/project"

export const projectMembersProjection = defineLinkProjection("project-members", Project.l.members)
  .fromDataset(erpProjectMembersDataset)
  .sourceField("project_id")
  .targetField("employee_id")
