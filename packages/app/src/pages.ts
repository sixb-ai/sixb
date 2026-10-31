/**
 * Pages the framework serves until a project adds its own at the same path, and the providers that
 * open their sections and carry the project's `toolViews` to every chat. Imported only by the
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
export { ConsoleActionRunPage } from "./pages/console/action-run"
export {
  ConsoleConnectorPage,
  ConsoleConnectorsPage,
} from "./pages/console/data/connectors"
export { ConsoleDatasetPage, ConsoleDatasetsPage } from "./pages/console/data/datasets"
export { ConsolePipelinePage, ConsolePipelinesPage } from "./pages/console/data/pipelines"
export { ConsoleProjectionPage, ConsoleProjectionsPage } from "./pages/console/data/projections"
export { ConsoleSyncPage, ConsoleSyncsPage } from "./pages/console/data/syncs"
export { ConsoleLogsPage } from "./pages/console/logs"
export { ConsoleActionsPage } from "./pages/console/ontology/actions"
export { ConsoleGraphPage } from "./pages/console/ontology/graph"
export { ObjectPage } from "./pages/console/ontology/object-page"
export {
  ConsoleObjectTypePage,
  ConsoleObjectTypesPage,
} from "./pages/console/ontology/object-types"
export { ConsoleObjectsPage } from "./pages/console/ontology/objects"
export { ConsoleRulePage, ConsoleRulesPage } from "./pages/console/ontology/rules"
export { ConsoleWorkflowPage } from "./pages/console/ontology/workflow"
export { ConsoleWorkflowsPage } from "./pages/console/ontology/workflows"
export { ConsoleWorkflowRunPage } from "./pages/console/workflow-run"
export { HomePage } from "./pages/home"
export { ConsoleIndexPage, SettingsIndexPage } from "./pages/section-page"
export { SettingsActivityPage } from "./pages/settings/activity/page"
export { SettingsActivityThreadPage } from "./pages/settings/activity/thread"
export { SettingsDevelopersPage } from "./pages/settings/developers"
export { SettingsMembersPage } from "./pages/settings/members"
export { SettingsMemoryPage } from "./pages/settings/memory"
export { SettingsPersonalPage } from "./pages/settings/personal"
export { SettingsUsagePage } from "./pages/settings/usage/page"
export { SectionsProvider } from "./sections/sections"
