export const OPENAPI_TAGS = {
  project: {
    name: "Project",
    description: "Current project metadata",
  },
  status: {
    name: "Status",
    description: "Runtime status",
  },
  ontology: {
    name: "Ontology",
    description: "Object type definitions",
  },
  connectors: {
    name: "Connectors",
    description: "Connector metadata",
  },
  connectorConnections: {
    name: "Connector Connections",
    description: "Connected external accounts",
  },
  connectorConnectionRuns: {
    name: "Connector Connection Runs",
    description: "Interactive OAuth connection runs",
  },
  webhooks: {
    name: "Webhooks",
    description: "Webhook run history",
  },
  datasets: {
    name: "Datasets",
    description: "Dataset definitions",
  },
  datasetVersions: {
    name: "Dataset Versions",
    description: "Dataset version history",
  },
  datasetRows: {
    name: "Dataset Rows",
    description: "Dataset row previews",
  },
  syncs: {
    name: "Syncs",
    description: "Sync metadata",
  },
  syncRuns: {
    name: "Sync Runs",
    description: "Sync run history and requests",
  },
  pipelines: {
    name: "Pipelines",
    description: "Pipeline metadata",
  },
  pipelineRuns: {
    name: "Pipeline Runs",
    description: "Pipeline run history and requests",
  },
  workflows: {
    name: "Workflows",
    description: "Workflow metadata",
  },
  workflowRuns: {
    name: "Workflow Runs",
    description: "Workflow run history and requests",
  },
  workflowInterventions: {
    name: "Workflow Interventions",
    description: "Workflow intervention tasks",
  },
  rules: {
    name: "Rules",
    description: "Rule definitions",
  },
  ruleStates: {
    name: "Rule States",
    description: "Active rule states",
  },
  projections: {
    name: "Projections",
    description: "Projection definitions",
  },
  projectionRuns: {
    name: "Projection Runs",
    description: "Projection run history",
  },
  objects: {
    name: "Objects",
    description: "Twin objects and state",
  },
  objectFiles: {
    name: "Object Files",
    description: "Object-backed file content",
  },
  actions: {
    name: "Actions",
    description: "Action metadata and requests",
  },
  actionRuns: {
    name: "Action Runs",
    description: "Action run history",
  },
  agents: {
    name: "Agents",
    description: "Agent catalog",
  },
  agentThreads: {
    name: "Agent Threads",
    description: "Agent conversation threads and messages",
  },
  agentRuns: {
    name: "Agent Runs",
    description: "Agent run state and cancellation",
  },
  files: {
    name: "Files",
    description: "File uploads and file references",
  },
  links: {
    name: "Links",
    description: "Object relationship links",
  },
  telemetry: {
    name: "Telemetry",
    description: "Telemetry history and appends",
  },
  events: {
    name: "Events",
    description: "Domain event stream",
  },
  logs: {
    name: "Logs",
    description: "Run log stream",
  },
  authSessions: {
    name: "Auth Sessions",
    description: "Authentication sessions and sign-out",
  },
  authMembers: {
    name: "Auth Members",
    description: "User membership administration",
  },
  authInvitations: {
    name: "Auth Invitations",
    description: "User invitations",
  },
  authAccessTokens: {
    name: "Auth Access Tokens",
    description: "Personal access-token management",
  },
  authServiceAccounts: {
    name: "Auth Service Accounts",
    description: "Service accounts and service-account access tokens",
  },
} as const

export const OPENAPI_TAG_METADATA = Object.values(OPENAPI_TAGS).map(({ name, description }) => ({
  name,
  description,
}))
