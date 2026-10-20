import type { ProjectReference } from "./types"

/**
 * Project-wide surfaces used in security grants such as `can.observe(project.logs)` and
 * `can.view(project.users)`.
 */
export const project: ProjectReference = Object.freeze({
  kind: "project",
  logs: Object.freeze({ kind: "logs" }),
  activity: Object.freeze({ kind: "activity" }),
  users: Object.freeze({ kind: "users" }),
})
