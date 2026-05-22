import { defineProjection, fromForeignKey } from "@pario/core"
import { erpTasksDataset } from "../datasets/erp"
import { Employee } from "../ontology/employee"
import { Project } from "../ontology/project"
import { Task } from "../ontology/task"

export const taskProjection = defineProjection("task-proj", Task)
  .fromDataset(erpTasksDataset)
  .properties({
    id: "id",
    title: "title",
    status: "status",
    priority: "priority",
    estimate: "estimate",
    dueDate: "dueDate",
    projectRef: "projectRef",
    assigneeRef: "assigneeRef",
  })
  .withLinks({
    project: fromForeignKey({
      link: Task.l.project,
      sourceProperty: Task.p.projectRef,
      target: Project,
    }),
    assignee: fromForeignKey({
      link: Task.l.assignee,
      sourceProperty: Task.p.assigneeRef,
      target: Employee,
    }),
  })
