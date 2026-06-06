import { defineProjection } from "@sixb/core"
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
  })
  .withLinks({
    project: {
      link: Task.l.project,
      sourceField: "project_id",
      target: Project,
    },
    assignee: {
      link: Task.l.assignee,
      sourceField: "assignee_id",
      target: Employee,
    },
  })
