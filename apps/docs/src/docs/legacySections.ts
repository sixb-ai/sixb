/** Old bookmarked sections that moved to a dedicated guide. Page redirects preserve their hash. */
export const legacySections: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "/connectors": {
    "define-an-oauth-connector": "/connectors/authentication#define-an-oauth-connector",
    "protect-oauth-credentials": "/connectors/authentication#protect-oauth-credentials",
    "connect-an-oauth-account-from-an-app":
      "/connectors/authentication#connect-an-oauth-account-from-an-app",
    connectorcontext: "/connectors#custom-clients",
    "built-in-adapters": "/connectors/library#protocol-adapters",
    restoptions: "/connectors/library#restoptions",
    "sqlconnection-and-sftpconnection-options":
      "/connectors/library#sqlconnection-and-sftpconnection-options",
    "hosted-service-connectors": "/connectors/library",
    webhooks: "/connectors/webhooks",
    "webhooks-updating-source-datasets": "/connectors/webhooks#webhooks-updating-source-datasets",
  },
  "/datasets": {
    "source-ordering": "/datasets/source-ordering",
    "merge-behavior": "/datasets/source-ordering#merge-behavior",
    "sequence-values": "/datasets/source-ordering#sequence-values",
    "v1-constraints": "/datasets/source-ordering#v1-constraints",
    "ingest-source-changes": "/connectors/webhooks#ingest-source-changes",
    "ingestion-recovery": "/connectors/webhooks#ingestion-recovery",
    "objects-and-relationships": "/connectors/webhooks#objects-and-relationships",
  },
  "/syncs": {
    "incremental-syncs-with-checkpoints": "/syncs/incremental#incremental-syncs-with-checkpoints",
    "merge-source-requirements": "/syncs/incremental#merge-source-requirements",
    schedules: "/schedules",
  },
  "/pipelines": {
    schedules: "/schedules",
    "running-pipelines": "/deployment#role-commands",
  },
  "/projections": { "running-projections": "/deployment#role-commands" },
  "/ontology/properties": {
    "object-type-search-profile": "/ontology/object-types#object-type-search-profile",
    "how-metadata-drives-queries": "/objects/querying#how-metadata-drives-queries",
  },
  "/ontology/value-types": {
    "inheritance-with-extends": "/ontology/object-types#extends-inheritance",
    "extends-vs-parents": "/ontology/object-types#extends-inheritance",
  },
}
