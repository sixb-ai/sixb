/**
 * Pages the framework serves until a project adds its own at the same path, and the provider that
 * carries the project's `visibility` to them. Imported only by the generated app; app code never
 * imports them.
 */
import { createElement } from "react"
import { SectionIndex } from "./pages/section-page"

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
export { SettingsDevelopersPage } from "./pages/settings/developers"
export { SettingsMembersPage } from "./pages/settings/members"
export { SettingsPersonalPage } from "./pages/settings/personal"
export { SettingsServiceAccountsPage } from "./pages/settings/service-accounts"
export { SectionsProvider } from "./sections/sections"

/** `/settings` opens the first Settings page this person may see. */
export function SettingsIndexPage() {
  return createElement(SectionIndex, { section: "settings" })
}

/** `/data` opens the first Data page this person may see. */
export function DataIndexPage() {
  return createElement(SectionIndex, { section: "data" })
}

/** `/observability` opens the first Observability page this person may see. */
export function ObservabilityIndexPage() {
  return createElement(SectionIndex, { section: "observability" })
}

/** `/ontology` opens the first Ontology page this person may see. */
export function OntologyIndexPage() {
  return createElement(SectionIndex, { section: "ontology" })
}
