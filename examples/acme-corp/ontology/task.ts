import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { Employee } from "./employee"
import { Project } from "./project"

export const Task = defineObjectType({
  id: "Task",
  name: "Task",
  description: "A unit of work within a project.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("status", stringEnum(["backlog", "todo", "in_progress", "review", "done"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("priority", stringEnum(["low", "medium", "high", "critical"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("estimate", "integer", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("dueDate", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
  search: {
    title: "title",
    defaultText: ["title"],
    exact: ["id", "title"],
  },
  links: [
    link("project", Project, { cardinality: "one" }),
    link("assignee", Employee, { cardinality: "one" }),
  ],
})
