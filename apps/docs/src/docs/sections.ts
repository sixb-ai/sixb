export interface SectionDef {
  readonly folder: string
  readonly title: string
}

// Documentation sections and search order. The sidebar groups these into broader categories.
// `folder` is the top-level directory under docs/ ("" = root-level pages,
// which form the Get Started section). Page order within a section comes from
// an optional `_meta.json` in the folder; the section Overview always leads.
export const sections: readonly SectionDef[] = [
  { folder: "", title: "Get Started" },
  { folder: "fundamentals", title: "Fundamentals" },
  { folder: "ontology", title: "Ontology" },
  { folder: "connectors", title: "Connectors" },
  { folder: "datasets", title: "Datasets" },
  { folder: "syncs", title: "Syncs" },
  { folder: "pipelines", title: "Pipelines" },
  { folder: "projections", title: "Projections" },
  { folder: "objects", title: "Objects" },
  { folder: "apps", title: "Building Apps" },
  { folder: "actions", title: "Actions" },
  { folder: "workflows", title: "Workflows" },
  { folder: "models", title: "Models" },
  { folder: "schedules", title: "Schedules" },
  { folder: "rules", title: "Rules" },
  { folder: "auth", title: "Auth" },
  { folder: "events", title: "Events & Webhooks" },
  { folder: "client", title: "Client SDK" },
  { folder: "runtime", title: "Runtime" },
  { folder: "infrastructure", title: "Infrastructure" },
  { folder: "sandboxes", title: "Sandboxes" },
  { folder: "server", title: "Server & API" },
  { folder: "deployment", title: "Deployment" },
  { folder: "logging", title: "Logging" },
  { folder: "testing", title: "Testing" },
  { folder: "examples", title: "Examples" },
]
