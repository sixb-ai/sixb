/**
 * The sections Sixb builds into every app, as plain data: the build reads it to add their routes,
 * and the browser reads it to draw their navigation. No React here, so the CLI can import it.
 *
 * A section is a group of pages at one path prefix. The Console opens to whoever holds
 * `can.observe(project.console)`. Settings opens to everyone signed in, and each of its project
 * pages to whoever may do what the page is for.
 */

export type AppSectionId = "console" | "settings"

/** What the session's `access` says whether this person may open. */
export type SectionAccess =
  | "console"
  | "logs"
  | "members"
  | "serviceAccounts"
  | "usage"
  | "activity"

export interface SectionPageDefinition {
  readonly id: string
  readonly path: string
  /** The page's export from `@sixb/app/pages`. */
  readonly exportName: string
  /** Pages sharing a group sit under one heading in the section's navigation. */
  readonly group?: string
  /** A signed-in person sees the page when the session's `access` allows any of these. */
  readonly requires?: readonly SectionAccess[]
  /** Pages for one item below this one, such as a single sync under Syncs. */
  readonly details?: readonly { readonly path: string; readonly exportName: string }[]
  /** Paths outside the section that open from this page and keep the section around them. */
  readonly activeFor?: readonly string[]
}

export interface SectionDefinition {
  readonly id: AppSectionId
  readonly path: string
  /** The export that answers the section's own path by opening its first page. */
  readonly indexExportName: string
  /** Every page needs a signed-in person, so the section is absent when auth is off. */
  readonly requiresUser: boolean
  /** A signed-in person sees the section when the session's `access` allows any of these. */
  readonly requires?: readonly SectionAccess[]
  readonly pages: readonly SectionPageDefinition[]
}

export const sectionCatalog: readonly SectionDefinition[] = [
  // In this order in the user menu, Settings last.
  {
    // What the project runs, how data reaches it, and what it models: the developer's view.
    id: "console",
    path: "/console",
    indexExportName: "ConsoleIndexPage",
    requiresUser: false,
    requires: ["console"],
    // Pages appear in this order; consecutive pages of one group share its heading.
    pages: [
      {
        id: "connectors",
        path: "/console/connectors",
        exportName: "ConsoleConnectorsPage",
        group: "data",
        details: [{ path: "/console/connectors/:connectorId", exportName: "ConsoleConnectorPage" }],
      },
      {
        id: "syncs",
        path: "/console/syncs",
        exportName: "ConsoleSyncsPage",
        group: "data",
        details: [{ path: "/console/syncs/:syncId", exportName: "ConsoleSyncPage" }],
      },
      {
        id: "datasets",
        path: "/console/datasets",
        exportName: "ConsoleDatasetsPage",
        group: "data",
        details: [{ path: "/console/datasets/:datasetId", exportName: "ConsoleDatasetPage" }],
      },
      {
        id: "pipelines",
        path: "/console/pipelines",
        exportName: "ConsolePipelinesPage",
        group: "data",
        details: [{ path: "/console/pipelines/:pipelineId", exportName: "ConsolePipelinePage" }],
      },
      {
        id: "projections",
        path: "/console/projections",
        exportName: "ConsoleProjectionsPage",
        group: "data",
        details: [
          { path: "/console/projections/:projectionId", exportName: "ConsoleProjectionPage" },
        ],
      },
      {
        id: "object-types",
        path: "/console/object-types",
        exportName: "ConsoleObjectTypesPage",
        group: "ontology",
        details: [
          { path: "/console/object-types/:objectTypeId", exportName: "ConsoleObjectTypePage" },
        ],
      },
      {
        id: "objects",
        path: "/console/objects",
        exportName: "ConsoleObjectsPage",
        group: "ontology",
        // An object's page lives outside the section, so people who cannot open it still can.
        activeFor: ["/objects"],
      },
      { id: "graph", path: "/console/graph", exportName: "ConsoleGraphPage", group: "ontology" },
      {
        id: "actions",
        path: "/console/actions",
        exportName: "ConsoleActionsPage",
        group: "ontology",
        details: [{ path: "/console/actions/runs/:runId", exportName: "ConsoleActionRunPage" }],
      },
      {
        id: "workflows",
        path: "/console/workflows",
        exportName: "ConsoleWorkflowsPage",
        group: "ontology",
        details: [
          { path: "/console/workflows/:workflowId", exportName: "ConsoleWorkflowPage" },
          { path: "/console/workflows/runs/:runId", exportName: "ConsoleWorkflowRunPage" },
        ],
      },
      {
        id: "rules",
        path: "/console/rules",
        exportName: "ConsoleRulesPage",
        group: "ontology",
        details: [{ path: "/console/rules/:ruleId", exportName: "ConsoleRulePage" }],
      },
      // Logs read across Data and Ontology, so they close the list rather than open it.
      {
        id: "logs",
        path: "/console/logs",
        exportName: "ConsoleLogsPage",
        requires: ["logs"],
      },
    ],
  },
  {
    id: "settings",
    path: "/settings",
    indexExportName: "SettingsIndexPage",
    requiresUser: true,
    // Pages appear in this order; consecutive pages of one group share its heading.
    pages: [
      {
        id: "personal",
        path: "/settings/personal",
        exportName: "SettingsPersonalPage",
        group: "account",
      },
      {
        id: "developers",
        path: "/settings/developers",
        exportName: "SettingsDevelopersPage",
        group: "account",
      },
      {
        id: "memory",
        path: "/settings/memory",
        exportName: "SettingsMemoryPage",
        group: "account",
      },
      {
        id: "members",
        path: "/settings/members",
        exportName: "SettingsMembersPage",
        group: "project",
        // People, groups and service accounts, each a tab for whoever may manage it. The people
        // listed are only those a person may change, so it is for those who can.
        requires: ["members", "serviceAccounts"],
      },
      {
        id: "usage",
        path: "/settings/usage",
        exportName: "SettingsUsagePage",
        group: "project",
        requires: ["usage"],
      },
      {
        id: "activity",
        path: "/settings/activity",
        exportName: "SettingsActivityPage",
        group: "project",
        requires: ["activity"],
        details: [
          {
            path: "/settings/activity/threads/:threadId",
            exportName: "SettingsActivityThreadPage",
          },
        ],
      },
    ],
  },
]
