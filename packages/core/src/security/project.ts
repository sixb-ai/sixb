import type { ProjectReference } from "./types"

/**
 * Project-wide surfaces used in security grants such as `can.observe(project.logs)`,
 * `can.view(project.users)`, `can.run(project.models)` and `can.manage(project.source)`.
 */
export const project: ProjectReference = Object.freeze({
  kind: "project",
  logs: Object.freeze({ kind: "logs" }),
  activity: Object.freeze({ kind: "activity" }),
  console: Object.freeze({ kind: "console" }),
  users: Object.freeze({ kind: "users" }),
  models: Object.freeze({ kind: "models" }),
  source: Object.freeze({ kind: "source" }),
})
