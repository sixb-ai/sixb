import { defineObjectType, link, prop, stringEnum } from "@pario/core"
import { Employee } from "./employee"
import { Project } from "./project"

export const Task = defineObjectType({
  id: "Task",
  name: "Task",
  description: "A unit of work within a project.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
    prop("status", stringEnum(["backlog", "todo", "in_progress", "review", "done"])),
    prop("priority", stringEnum(["low", "medium", "high", "critical"])),
    prop("estimate", "integer"),
    prop("dueDate", "date"),
    prop("projectRef", "string"),
    prop("assigneeRef", "string"),
  ],
  links: [
    link("project", Project, { cardinality: "one" }),
    link("assignee", Employee, { cardinality: "one" }),
  ],
})
