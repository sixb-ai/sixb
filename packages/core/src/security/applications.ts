import type { ApplicationDefinition } from "./types"

/** Browser applications that can be protected by role grants. */
export const applications = {
  atlas: { kind: "application", id: "atlas", label: "Atlas" },
  app: { kind: "application", id: "app", label: "Custom app" },
} as const satisfies Readonly<Record<string, ApplicationDefinition>>

export const APPLICATION_IDS: ReadonlySet<string> = new Set(
  Object.values(applications).map((application) => application.id)
)
