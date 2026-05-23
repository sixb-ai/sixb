import { defineProjection, fromForeignKey } from "@sixb/core"
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
    projectRef: "projectRef",
    authorRef: "authorRef",
  })
  .withLinks({
    project: fromForeignKey({
      link: Document.l.project,
      sourceProperty: Document.p.projectRef,
      target: Project,
    }),
    author: fromForeignKey({
      link: Document.l.author,
      sourceProperty: Document.p.authorRef,
      target: Employee,
    }),
  })
