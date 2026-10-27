/**
 * Pages the framework serves until a project adds its own at the same path, and the providers that
 * carry the project's `visibility` to them and its `toolViews` to every chat. Imported only by the
 * generated app; app code never imports them.
 *
 * Keep this module to re-exports. The build resolves relative imports through a plugin, and Bun
 * then keeps the whole graph of a module imported here for its own code: every app with a layout
 * would bundle every page.
 */
export {
  AgentThreadRedirect,
  ThreadPage,
  ThreadsPage,
} from "./agent/thread-pages"
export { AgentToolViewsProvider } from "./agent/tool-views/registry"
export { ArtifactPage } from "./artifacts/artifact-page"
export { ArtifactsPage } from "./artifacts/gallery"
export {
  DataConnectorPage,
  DataConnectorsPage,
} from "./pages/data/connectors"
export { DataDatasetPage, DataDatasetsPage } from "./pages/data/datasets"
export { DataPipelinePage, DataPipelinesPage } from "./pages/data/pipelines"
export { DataProjectionPage, DataProjectionsPage } from "./pages/data/projections"
export { DataSyncPage, DataSyncsPage } from "./pages/data/syncs"
export { HomePage } from "./pages/home"
export { ObservabilityActionRunPage } from "./pages/observability/action-run"
export { ObservabilityActivityPage } from "./pages/observability/activity/page"
export { ObservabilityAgentThreadPage } from "./pages/observability/activity/thread"
export { ObservabilityAiUsagePage } from "./pages/observability/ai-usage/page"
export { ObservabilityLogsPage } from "./pages/observability/logs"
export { ObservabilityRunsPage } from "./pages/observability/runs"
export { ObservabilityWorkflowRunPage } from "./pages/observability/workflow-run"
export { OntologyActionsPage } from "./pages/ontology/actions"
export { OntologyGraphPage } from "./pages/ontology/graph"
export { ObjectPage } from "./pages/ontology/object-page"
export { OntologyObjectTypePage, OntologyObjectTypesPage } from "./pages/ontology/object-types"
export { OntologyObjectsPage } from "./pages/ontology/objects"
export { OntologyRulePage, OntologyRulesPage } from "./pages/ontology/rules"
export { OntologyWorkflowPage } from "./pages/ontology/workflow"
export { OntologyWorkflowsPage } from "./pages/ontology/workflows"
export {
  DataIndexPage,
  ObservabilityIndexPage,
  OntologyIndexPage,
  SettingsIndexPage,
} from "./pages/section-page"
export { SettingsDevelopersPage } from "./pages/settings/developers"
export { SettingsMembersPage } from "./pages/settings/members"
export { SettingsMemoryPage } from "./pages/settings/memory"
export { SettingsPersonalPage } from "./pages/settings/personal"
export { SettingsServiceAccountsPage } from "./pages/settings/service-accounts"
export { SectionsProvider } from "./sections/sections"
