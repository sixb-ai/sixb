import { defineProjection } from "@sixb/core"
import { erpDocumentsDataset } from "../datasets/erp"
import { Document } from "../ontology/document"
import { Employee } from "../ontology/employee"
import { Project } from "../ontology/project"

export const documentProjection = defineProjection("document-proj", Document)
  .fromDataset(erpDocumentsDataset)
  .properties({
    id: "id",
    title: "title",
    type: "type",
    version: "version",
    createdAt: "createdAt",
    attachment: "attachment",
  })
  .withLinks({
    project: {
      link: Document.l.project,
      sourceField: "project_id",
      target: Project,
    },
    author: {
      link: Document.l.author,
      sourceField: "author_id",
      target: Employee,
    },
  })
