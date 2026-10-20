/**
 * The sections Sixb builds into every app, as plain data: the build reads it to add their routes,
 * and the browser reads it to draw their navigation. No React here, so the CLI can import it.
 *
 * A section is a group of pages at one path prefix. Its visibility key, set in the project's
 * `visibility` export, decides who sees its pages; pages marked `always` stay open to every
 * signed-in person, because they are about that person rather than the project.
 */

export type AppSectionId = "data" | "observability" | "ontology" | "settings"

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
      { id: "activity", path: "/observability/activity", exportName: "ObservabilityActivityPage" },
    ],
  },
  {
    id: "ontology",
    path: "/ontology",
    indexExportName: "OntologyIndexPage",
    requiresUser: false,
    pages: [
      {
        id: "object-types",
        path: "/ontology/object-types",
        exportName: "OntologyObjectTypesPage",
        group: "model",
        details: [
          { path: "/ontology/object-types/:objectTypeId", exportName: "OntologyObjectTypePage" },
        ],
      },
      {
        id: "objects",
        path: "/ontology/objects",
        exportName: "OntologyObjectsPage",
        group: "model",
        // An object's page lives outside the section, so people who cannot open it still can.
        activeFor: ["/objects"],
      },
      { id: "graph", path: "/ontology/graph", exportName: "OntologyGraphPage", group: "model" },
      {
        id: "actions",
        path: "/ontology/actions",
        exportName: "OntologyActionsPage",
        group: "logic",
      },
      {
        id: "workflows",
        path: "/ontology/workflows",
        exportName: "OntologyWorkflowsPage",
        group: "logic",
        details: [{ path: "/ontology/workflows/:workflowId", exportName: "OntologyWorkflowPage" }],
      },
      {
        id: "rules",
        path: "/ontology/rules",
        exportName: "OntologyRulesPage",
        group: "logic",
        details: [{ path: "/ontology/rules/:ruleId", exportName: "OntologyRulePage" }],
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
