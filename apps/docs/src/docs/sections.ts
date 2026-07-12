export interface SectionDef {
  readonly folder: string
  readonly title: string
}

// The sidebar renders one collapsible group per entry, in this order.
// `folder` is the top-level directory under docs/ ("" = root-level pages,
// which form the Get Started section). Page order within a section comes from
// an optional `_meta.json` in the folder; the section Overview always leads.
export const sections: readonly SectionDef[] = [
  { folder: "", title: "Get Started" },
  { folder: "fundamentals", title: "Fundamentals" },
  { folder: "runtime", title: "Runtime" },
  { folder: "ontology", title: "Ontology" },
  { folder: "objects", title: "Objects" },
  { folder: "actions", title: "Actions" },
  { folder: "schedules", title: "Schedules" },
  { folder: "data", title: "Data" },
  { folder: "rules", title: "Rules" },
  { folder: "workflows", title: "Workflows" },
  { folder: "agents", title: "Agents" },
  { folder: "sandboxes", title: "Sandboxes" },
  { folder: "events", title: "Events & Webhooks" },
  { folder: "logging", title: "Logging" },
  { folder: "apps", title: "Building Apps" },
  { folder: "client", title: "Client SDK" },
  { folder: "server", title: "Server & API" },
  { folder: "auth", title: "Auth" },
  { folder: "infrastructure", title: "Infrastructure" },
  { folder: "deployment", title: "Deployment" },
  { folder: "testing", title: "Testing" },
  { folder: "examples", title: "Examples" },
]
