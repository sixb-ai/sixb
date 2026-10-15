/**
 * The sections Sixb builds into every app, as plain data: the build reads it to add their routes,
 * and the browser reads it to draw their navigation. No React here, so the CLI can import it.
 *
 * A section is a group of pages at one path prefix. Its visibility key, set in the project's
 * `visibility` export, decides who sees its pages; pages marked `always` stay open to every
 * signed-in person, because they are about that person rather than the project.
 */

export type AppSectionId = "data" | "observability" | "settings"

export interface SectionPageDefinition {
  readonly id: string
  readonly path: string
  /** The page's export from `@sixb/app/pages`. */
  readonly exportName: string
  /** Pages sharing a group sit under one heading in the section's navigation. */
  readonly group?: string
  readonly always?: boolean
  /** Pages for one item below this one, such as a single sync under Syncs. */
  readonly details?: readonly { readonly path: string; readonly exportName: string }[]
}

export interface SectionDefinition {
  readonly id: AppSectionId
  readonly path: string
  /** The export that answers the section's own path by opening its first page. */
  readonly indexExportName: string
  /** Every page needs a signed-in person, so the section is absent when auth is off. */
  readonly requiresUser: boolean
  readonly pages: readonly SectionPageDefinition[]
}

export const sectionCatalog: readonly SectionDefinition[] = [
  // In this order in the user menu, Settings last.
  {
    id: "data",
    path: "/data",
    indexExportName: "DataIndexPage",
    requiresUser: false,
    pages: [
      {
        id: "connectors",
        path: "/data/connectors",
        exportName: "DataConnectorsPage",
        details: [{ path: "/data/connectors/:connectorId", exportName: "DataConnectorPage" }],
      },
      {
        id: "syncs",
        path: "/data/syncs",
        exportName: "DataSyncsPage",
        details: [{ path: "/data/syncs/:syncId", exportName: "DataSyncPage" }],
      },
      {
        id: "datasets",
        path: "/data/datasets",
        exportName: "DataDatasetsPage",
        details: [{ path: "/data/datasets/:datasetId", exportName: "DataDatasetPage" }],
      },
      {
        id: "pipelines",
        path: "/data/pipelines",
        exportName: "DataPipelinesPage",
        details: [{ path: "/data/pipelines/:pipelineId", exportName: "DataPipelinePage" }],
      },
      {
        id: "projections",
        path: "/data/projections",
        exportName: "DataProjectionsPage",
        details: [{ path: "/data/projections/:projectionId", exportName: "DataProjectionPage" }],
      },
    ],
  },
  {
    id: "observability",
    path: "/observability",
    indexExportName: "ObservabilityIndexPage",
    requiresUser: false,
    pages: [
      {
        id: "runs",
        path: "/observability/runs",
        exportName: "ObservabilityRunsPage",
        details: [
          {
            path: "/observability/runs/workflows/:runId",
            exportName: "ObservabilityWorkflowRunPage",
          },
          { path: "/observability/runs/actions/:runId", exportName: "ObservabilityActionRunPage" },
        ],
      },
      { id: "logs", path: "/observability/logs", exportName: "ObservabilityLogsPage" },
      { id: "ai-usage", path: "/observability/ai-usage", exportName: "ObservabilityAiUsagePage" },
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
        always: true,
      },
      {
        id: "developers",
        path: "/settings/developers",
        exportName: "SettingsDevelopersPage",
        group: "account",
        always: true,
      },
      {
        id: "members",
        path: "/settings/members",
        exportName: "SettingsMembersPage",
        group: "project",
      },
      {
        id: "service-accounts",
        path: "/settings/service-accounts",
        exportName: "SettingsServiceAccountsPage",
        group: "project",
      },
    ],
  },
]

export const sectionIds: readonly AppSectionId[] = sectionCatalog.map((section) => section.id)
