# Changelog

Sixb packages are versioned independently. Each release entry names the packages that shipped.

## 2026-10-05 — Framework 0.1.16

### Highlights

- Scope vector searches with traversals, explicit object references, or set operations before
  ranking. Resolve the vector profile on the resulting concrete object type and apply object,
  link, and source-property authorization before selecting the nearest results.
- Send separate document and query purposes through embedding execution. Vercel AI Gateway
  translates them for Voyage 4, Voyage 4 Lite, Voyage 4 Large, and Cohere Embed v4.0, with
  retrieval-aware model identity, disabled truncation, and conservative batching bounds.
- Preserve embedding purpose through Azure AI Foundry model resolution and expose optional
  `inputMode` in ontology API responses and generated client types.
- Reduce SQLite vector-list work to one bounded candidate scan for admission, ranking, and
  totals, hydrate results after top-k selection, and improve authorized traversal query plans.

### Upgrade notes

- Upgrade core, exact worker/storage consumers, server, client, and CLI together to `0.1.16`.
  Upgrade Vercel AI Gateway to `0.1.5` and Azure AI Foundry to `0.1.3` when used. No new SQL
  migration is introduced after `0.1.15`; deployments upgrading from older releases must still
  apply their intervening migrations and upgrade notes.
- Existing Voyage/Cohere vector profiles now use asymmetric document/query preparation. This
  changes their vector configuration identity: old vectors no longer match searches with the
  new configuration. Explicitly reindex existing objects; a configuration change alone does not
  trigger a historical backfill. Plan provider costs and reduced search coverage until indexing
  completes. Unchanged symmetric profiles retain their previous configuration identity.
- Direct embedding calls to the supported Voyage/Cohere bindings must supply
  `purpose: "document"` or `purpose: "query"`. Sixb indexing and text search supply it automatically.
  Custom embedding adapters and wrappers should preserve the optional purpose field and declare
  asymmetric input mode when preparation differs. Byte batching bounds are not token guarantees.
- Vector ranking still requires one concrete result type. Pagination, expansion, traversal after
  ranking, and combined keyword/vector search remain unsupported. SQLite rejects candidate-budget
  overflow instead of silently ranking a truncated set; narrow the candidate scope when needed.
- The Gateway adapter retains a route-specific Voyage output-dimension override because the
  common dimensions field was observed to be ignored on that route. Validate actual dimensions
  and retrieval quality against the configured live provider before reindexing production data.

### Package versions

- `0.1.16`: `@sixb/core`, `@sixb/client`, `@sixb/server`, `@sixb/cli`, `@sixb/orchestrator`,
  `@sixb/pg`, `@sixb/sqlite`, `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/pipeline-worker`,
  `@sixb/projection-worker`, `@sixb/rules-worker`, `@sixb/sync-worker`, `@sixb/workflow-worker`.
- `0.1.5`: `@sixb/vercel-ai-gateway`.
- `0.1.3`: `@sixb/azure-ai-foundry`.

## 2026-10-05 — Framework 0.1.15

### Highlights

- Deploy committed projects over SSH with `sixb deploy`, `defineDeploy` from `@sixb/core/deploy`,
  and the new `@sixb/deploy-ssh` target. Set up servers, supervise services, configure HTTPS,
  manage deploy access, and generate a GitHub Actions deployment workflow.
- Resume projection candidates across retries, supersede stale object/link projection runs, and
  show the last attempt's failure while a run is retrying. Rebind a projection to another dataset
  without changing its ID, withdrawing obsolete source values while preserving application edits.
- Compact PostgreSQL and SQLite source storage and reclaim abandoned projection candidates sooner.
- Improve PostgreSQL connection-loss handling, explain exhausted lock-table errors, and support
  explicit direct TLS connections with `sslnegotiation=direct`.
- Add the FullEnrich connector for enrichment, reverse email lookup, search, signed webhooks, and
  agent tools. Add Microsoft drive-item previews and connector icons and sync filtering in Atlas.
- Make `sixb check` exit after printing its report even when provider handles remain open.
- Add the Plaud connector for recordings, transcripts, notes, and audio downloads, with
  Sixb-managed OAuth connections and token refresh.

### Upgrade notes

- Upgrade core, exact worker/storage consumers, server, client, and CLI together to `0.1.15`,
  Atlas to `0.1.13`, and the Microsoft connector to `0.1.2`. Rebuild application assets.
- Apply PostgreSQL and SQLite migrations 051–052 with old runtime roles stopped. Migration 051
  admits the terminal projection status `superseded` and errors on retrying runs; SQLite rebuilds
  `projection_runs`. Migration 052 rewrites source roots and rows with compact numeric references;
  SQLite also rebuilds the source-version table. Rehearse on a representative `0.1.14` database
  backup, measure downtime and disk/WAL requirements, and verify projections after migration.
  Rollback requires a database backup and matching binaries, not just an older application commit.
  With SQLite, migrate once before starting additional roles with `--no-migrate`.
- Handle `superseded` in projection status consumers. A `running` run may now have an `error`
  describing its last failed attempt; it is not necessarily terminal. Telemetry runs are not
  superseded. Abandoned source candidates no longer wait for `terminalSourceRetentionMs` and
  are cleaned in larger batches independently of `cleanupLimit`.
- Direct PostgreSQL TLS requires one TCP endpoint supporting PostgreSQL ALPN (PostgreSQL 17+
  without an incompatible proxy/pooler) and an explicit TLS mode. Prefer `verify-full` for
  certificate and hostname verification; `require` does not verify the certificate. Existing
  TLS negotiation remains the default. The installed postgres.js 3.4.9 still has a known crash
  window when a connection disappears between statements; retain process supervision.
- SSH deployment initially targets Ubuntu/Debian with systemd and Caddy. Only committed source
  is uploaded; keep secrets in the server's `.env`. Setup requires an administrator, and generated
  CI setup changes repository secrets and authorizes a deploy key. Deployment includes downtime;
  a failure after stopping services leaves them stopped. Deploying an older ref does not undo
  migrations. Separate deploy accounts are not isolation from the shared network or Caddy.
- Authorize Microsoft file access before returning a preview: anyone holding its URL can use it.
  FullEnrich search/enrichment spends provider credits; expose only the intended agent tools.
- Plaud requires registering an OAuth client for your deployment and enabling cloud sync.
  It follows the official Plaud MCP protocol rather than a guaranteed public account API;
  provider endpoints may change independently. Validate authorization and real account access.

### Package versions

- `0.1.15`: `@sixb/core`, `@sixb/client`, `@sixb/server`, `@sixb/cli`, `@sixb/orchestrator`,
  `@sixb/pg`, `@sixb/sqlite`, `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/pipeline-worker`,
  `@sixb/projection-worker`, `@sixb/rules-worker`, `@sixb/sync-worker`, `@sixb/workflow-worker`.
- `0.1.13`: `@sixb/atlas`.
- `0.1.2`: `@sixb/connector-microsoft`.
- Initial `0.1.0`: `@sixb/connector-fullenrich`, `@sixb/connector-plaud`, `@sixb/deploy-ssh`.

## 2026-09-29 — Framework 0.1.14

### Highlights

- Configure OIDC sign-in for a single Microsoft Entra tenant with `trustedEmail`. Standard claims
  are typed, and providers sending `email_verified` as the string `"true"` are supported.
- Map provider claims to Sixb groups with the OIDC `groups` option. Reconcile directory-owned
  memberships at each sign-in without removing memberships granted manually or by invitation.
- Show identity-provider-managed groups in Atlas and prevent their removal through member editing.
  Member API responses now include `managedGroupIds`.
- Explain refused OIDC sign-ins with actionable messages for uninvited or suspended users,
  disallowed domains, and providers that supply no trusted address.

### Upgrade notes

- Upgrade core, its exact worker/storage consumers, server, client, and CLI together to `0.1.14`.
  Upgrade OIDC to `0.1.4`, magic-link to `0.1.5`, and Atlas to `0.1.12`; rebuild application assets.
- Apply PostgreSQL and SQLite migration 050 before enabling directory-managed groups. PostgreSQL
  replaces a source constraint; SQLite rebuilds `auth_group_memberships` and its group index,
  preserving existing memberships. Rehearse against a backup of a `0.1.13` database, stop old
  runtime roles before migrating, and plan rollback with a database backup and matching binaries.
  With SQLite, migrate once before starting multiple roles with `--no-migrate`.
- OIDC strategies must supply a trusted address on every sign-in. The default requires a verified
  `email`; Entra deployments must explicitly configure `trustedEmail`, normally from
  `preferred_username`, and use a tenant-specific issuer, not `common` or `organizations`.
  Review account linking and invitation addresses before enabling a custom trust callback.
- UserInfo is fetched only when the ID token lacks a trusted address. When fetched, ID-token claims
  take precedence. Ensure claims needed by your `groups` mapping are available in that flow.
- A nonempty provider group mapping permits account creation without an invitation. Validate the
  mapping and provider assignments carefully. Membership changes apply at the next sign-in; suspend
  a user in Sixb when access must stop immediately. Omitting `groups` leaves existing directory
  memberships untouched; returning an empty array removes only directory-owned memberships.
- A group already granted manually or by invitation retains its original source. Removing that
  group at the provider does not revoke the independently granted membership. Directory-owned
  groups cannot be removed through the member API or Atlas; edit them at the provider.
- Custom auth strategies calling `completeOidcSignIn` must validate address trust before storage:
  `emailVerified` and `autoLinkByVerifiedEmail` were removed. The unused
  `requireNoActiveUsersForUserCreation` input was removed from OIDC and magic-link completion.
  Update explicit member response types and fixtures for the required `managedGroupIds` field.

### Package versions

- `0.1.14`: `@sixb/core`, `@sixb/client`, `@sixb/server`, `@sixb/cli`, `@sixb/orchestrator`,
  `@sixb/pg`, `@sixb/sqlite`, `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/pipeline-worker`,
  `@sixb/projection-worker`, `@sixb/rules-worker`, `@sixb/sync-worker`, `@sixb/workflow-worker`.
- `0.1.12`: `@sixb/atlas`.
- `0.1.4`: `@sixb/auth-oidc`.
- `0.1.5`: `@sixb/auth-magic-link`.

## 2026-09-28 — Framework 0.1.13

### Highlights

- Sign native clients and the CLI in with refreshable bearer sessions, including authenticated
  WebSockets. Authorize native clients and access tokens through grants independently of web-app
  access.
- Persist upload sessions across restarts and replicas with PostgreSQL and SQLite. Enforce
  expiration and clean up abandoned provider uploads.
- Type SDK surfaces from a shared ontology registry, add user references with `ref.user()`, and
  render Atlas values from their declared schemas.
- Fence objects returned by Action query and list reads, reporting changed reads as
  `action.read_conflict`.
- Attribute ontology commits and events to their requester and executor.
- Add Instagram and Facebook media publishing and semantic search through vector profiles in the
  CLI.
- Resolve relative sandbox command directories against the workspace and run SmolVM commands in the
  guest workspace. Introduce a separately published Agent image with document, rendering, and
  browser tools.

### Upgrade notes

- Upgrade core, exact worker/storage consumers, server, client, and CLI together to 0.1.13. Upgrade
  the changed sandbox providers and rebuild custom-app and Atlas assets with the matching
  dependencies.
- Apply PostgreSQL and SQLite migrations 046–049. Migration 046 normalizes intervention actors to
  `{ type, id }`. Migration 047 replaces commit `actor` with requester/executor attribution,
  backfills existing commits, and rewrites unpublished outbox events. Migration 048 adds persistent
  upload sessions. Migration 049 adds native-session state and removes the device authorization
  token-name and token-expiration columns.
- Stop old runtime roles before migration and rehearse on a backup of a 0.1.12 database. Measure
  migration 047 against representative commit and outbox volumes. Do not assume old and new
  binaries can safely overlap. Plan rollback through database restoration and matching old
  binaries; with SQLite, migrate once before starting multiple roles with `--no-migrate`.
- Update consumers of event/commit `actor` to `requestedBy` and `executor`. Review replay consumers
  of historical events as well as live delivery; the migration rewrites the database outbox, not
  external event archives.
- Update explicit SDK type annotations to the shared ontology registry. Removed exports include
  `EventActor`, `SecurityContext`, `RegisteredObjectType`, `RegisteredValueTypes`, and the former
  `ActionReadObjectByIdHandle`, `ActionReadObjectSet`, and `ActionReadObjectSetSource` types. Use
  the current `ObjectReader`, `ObjectReadByIdHandle`, and `ObjectReadSet` contracts where
  applicable.
- Handle `action.read_conflict` explicitly in custom Action interfaces and integrations; do not
  treat an obsolete read as a successful write.
- Interactive CLI login now establishes a renewable native session. Personal access-token profiles
  remain supported. Verify login, refresh, revocation/logout, and native WebSockets after
  upgrading; coordinate new CLI/client deployment with the new server.
- Check `trustedProxies` against deployment topology. The server defaults to trusting private,
  loopback, and link-local proxy networks when resolving forwarded client addresses.
- Upload-session routes return 501 if storage does not implement `fileUploadSessions`; there is no
  in-memory fallback for these routes. Single-request file uploads remain separate.
- Configure SmolVM with an explicit `image`. A local archive supports offline boot and must match
  the host architecture. Its normal working directory is `/workspace` in the guest.
- The Agent image is versioned independently of npm as `ghcr.io/sixb-ai/sixb-agent:1.2.0`. Pin a
  verified digest in production; the npm framework version is not an image tag.

### Package versions

- `0.1.13`: `@sixb/core`, `@sixb/client`, `@sixb/server`, `@sixb/cli`, `@sixb/orchestrator`,
  `@sixb/pg`, `@sixb/sqlite`, `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/pipeline-worker`,
  `@sixb/projection-worker`, `@sixb/rules-worker`, `@sixb/sync-worker`, `@sixb/workflow-worker`.
- `0.1.10`: `@sixb/agent-ui`.
- `0.1.11`: `@sixb/atlas`.
- `0.1.6`: `@sixb/cli-core`, `@sixb/sandboxes-apple-container`, `@sixb/sandboxes-local`,
  `@sixb/sandboxes-smolvm`, `@sixb/sandboxes-vercel`.
- `0.1.3`: `@sixb/connector-companycam`, `@sixb/connector-pandadoc`, `@sixb/connector-pipedrive`,
  `@sixb/connector-stripe`, `@sixb/connector-unipile`.
- `0.1.4`: `@sixb/connector-github`, `@sixb/connector-mercury`, `@sixb/connector-meta`.

## 2026-09-24 — Framework 0.1.12

### Highlights

- Introduce named vector profiles, automatic batched indexing, server-side text embedding for
  search, PostgreSQL and SQLite search, and Atlas profile visibility. Add Foundry embeddings with
  pinned representation identity and usage accounting.
- Add typed decision evaluation, the TypeSafe provider, and Vercel AI Gateway decision models.
- Persist conversation sandbox files across runs, recover confirmed lost state, and configure
  source/setup environments. Add execution-scoped GitHub App access to private repositories.
- Unify Agent surfaces and preserve conversation state across navigation.
- Add the Monday connector, LinkedIn and TikTok media publishing, Google Drive streaming downloads,
  and QuickBooks documents, attachments, and aging reports.
- Preserve safe error explanations across runtime boundaries.

### Upgrade notes

- Upgrade core, exact worker/storage consumers, and CLI together to 0.1.12. Upgrade sandbox
  providers and rebuild custom-app and Atlas assets.
- Apply PostgreSQL and SQLite migrations 041–045. SQLite 043 rebuilds executions; PostgreSQL 043
  changes execution constraints. Stop old runtime roles and rehearse against a backup of a 0.1.11
  database. Plan rollback through database restoration and matching old binaries. With SQLite,
  migrate once before starting multiple roles with --no-migrate.
- Replace removed query.vector and search.vector metadata with named search.vectors profiles. Adapt
  queries and reindex; do not assume legacy embedding properties migrate automatically.
- Vector persistence needs no extension. PostgreSQL search requires pgvector in the public schema.
  SQLite search loads sqlite-vec; macOS requires an extension-capable SQLite library configured
  before connections open. Search is exact and bounded to 10,000 eligible vectors and 16 million
  coordinates.
- Review third-party sandbox implementations against the new creation, resume, and
  execution-prepared authentication contracts. Bound conversations require a persistence-capable
  provider; workflows and subagents remain ephemeral.
- Confirmed lost sandbox state may be recreated without restoring local edits. Uncertain state
  blocks further runs until explicit recovery. Provider retention still applies. Normal cleanup
  revokes managed GitHub access; a worker crash cannot guarantee immediate revocation. Never put
  credentials in guest-readable environment variables or thread parameters.
- Replace the removed ThreadSidebar export. AgentWorkspaceProvider no longer accepts sidebarHeader,
  sidebarFooter, or sidebarWidth; adapt custom Agent layouts.

### Package versions

- `0.1.12`: `@sixb/core`, `@sixb/client`, `@sixb/server`, `@sixb/cli`, `@sixb/orchestrator`,
  `@sixb/pg`, `@sixb/sqlite`, `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/pipeline-worker`,
  `@sixb/projection-worker`, `@sixb/rules-worker`, `@sixb/sync-worker`, `@sixb/workflow-worker`.
- `0.1.9`: `@sixb/agent-ui`, `@sixb/app`.
- `0.1.10`: `@sixb/atlas`.
- `0.1.2`: `@sixb/azure-ai-foundry`.
- `0.1.4`: `@sixb/vercel-ai-gateway`, `@sixb/connector-tiktok`.
- `0.1.5`: `@sixb/queues-bullmq`, `@sixb/sandboxes-apple-container`, `@sixb/sandboxes-local`,
  `@sixb/sandboxes-smolvm`, `@sixb/sandboxes-vercel`.
- `0.1.1`: `@sixb/sandboxes-azure`, `@sixb/connector-quickbooks`.
- `0.1.3`: `@sixb/connector-github`.
- `0.1.6`: `@sixb/connector-google`.
- `0.1.7`: `@sixb/connector-linkedin`.
- `0.1.0`, first publications: `@sixb/typesafe`, `@sixb/connector-monday`.

## 2026-09-20 — Framework 0.1.11

### Highlights

- Add Azure AI Foundry deployment discovery, model capabilities and pricing, publisher display,
  and Responses, Chat, and Messages inference through shared model protocol implementations.
  Move Anthropic and Vercel AI Gateway onto those protocols and guard interrupted tool calls.
- Introduce Azure Blob Storage with verified multipart uploads and an Azure Container Apps
  sandbox provider for ephemeral agent execution.
- Expose browser-safe `SIXB_PUBLIC_` runtime environment values through `publicEnv` in custom apps,
  and allow file navigation to authenticate with the app session.
- Preserve OAuth callback redirects and let users resume pending connector account selection
  after returning to the application, without an account-selection deadline.
- Accelerate outbox delivery, drain safely during shutdown, and recover failed Redis command
  connections. Add an indexed, bounded SQLite outbox claim path.
- Stream large DuckLake reads with bounded concurrency, fix SQLite catalog writes, and bound
  dataset version scans used by pipelines, projections, and maintenance.

### Upgrade notes

- Upgrade core, its exact worker and storage consumers, and the CLI to `0.1.11` together. Rebuild
  custom-app assets with the updated app and client packages.
- Apply SQLite migration 040 before deployment; it adds the outbox publication-order index.
  PostgreSQL has no new migration since `0.1.10`. Rehearse on a backup; there is no database
  downgrade path. For SQLite, migrate once before starting runtime roles with `--no-migrate`.
- Account-selection run responses no longer contain `expiresAt`. Update custom connection UIs
  that rely on that field; OAuth authorization deadlines still apply before account selection.
- Only put browser-safe values in `SIXB_PUBLIC_` variables: they are visible to every app user.
  Restart the app server to pick up changes; rebuilding the app is unnecessary for value changes.
- Foundry requires a full Azure project URL and an API key with deployment-discovery and inference
  access. Azure sandboxes require an existing sandbox group and support ephemeral execution only;
  named persistence and resume are unsupported.
- Four packages require first publication: `@sixb/model-protocols`, `@sixb/azure-ai-foundry`,
  `@sixb/blob-azure`, and `@sixb/sandboxes-azure`. Preserve their existing manifest versions below.
  Rehearse their bootstrap against a local registry before explicitly publishing them under
  `latest`. The normal `next` plan is blocked until `@sixb/model-protocols@0.1.1` is available,
  because the updated Anthropic and Vercel AI Gateway providers require it exactly. Stage core
  `0.1.11` under `next` first to satisfy the new packages' packed dependency floors. Bootstrap
  model protocols before Foundry, then stage the remaining existing-package updates under `next`,
  verify them, and promote the same artifacts to `latest`.

### Package versions

- `0.1.11`: `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/cli`, `@sixb/client`, `@sixb/core`,
  `@sixb/orchestrator`, `@sixb/pg`, `@sixb/pipeline-worker`, `@sixb/projection-worker`,
  `@sixb/rules-worker`, `@sixb/server`, `@sixb/sqlite`, `@sixb/sync-worker`,
  `@sixb/workflow-worker`.
- `0.1.8`: `@sixb/app`.
- `0.1.7`: `@sixb/ducklake`.
- `0.1.6`: `@sixb/broker-redis`.
- `0.1.5`: `@sixb/lake-local`.
- `0.1.3`: `@sixb/anthropic`, `@sixb/vercel-ai-gateway`.
- `0.1.1`: `@sixb/azure-ai-foundry`, `@sixb/blob-azure`, `@sixb/model-protocols`
  (first publications).
- `0.1.0`: `@sixb/sandboxes-azure` (first publication).

## 2026-09-19 — Framework 0.1.10

### Highlights

- Materialize only changed object and link projection roots with DuckLake and in-memory lake
  storage, retaining complete replacement as a fallback. Show incremental changes read in Atlas
  and expose the counter through the API and generated client.
- Reduce projection, queue, PostgreSQL cardinality validation, and outbox overhead. Bound broker
  consumer buffering, await asynchronous handlers, and retry runtime dispatch within the handler.
- Support per-stream retention overrides in the in-memory, Redis, and NATS brokers.
- Add OAuth callback parameters, encrypted provider authorization context, configurable PKCE,
  and managed connection clients in webhook handlers. Adapt LinkedIn and TikTok OAuth handling.
- Add Microsoft Graph subscriptions, Outlook mail subscription helpers, and verified webhook
  delivery, including subscription validation and lifecycle notifications.
- Introduce the QuickBooks Online Accounting connector with managed OAuth, queries, change data
  capture, verified webhooks, and typed accounting reads and writes.

### Upgrade notes

- Upgrade core, its exact worker and storage consumers, and the CLI to `0.1.10` together. Rebuild
  Atlas assets to include incremental projection counters.
- Apply PostgreSQL migrations 038–040 or SQLite migrations 038–039. These add projection source
  root history and optional OAuth PKCE; PostgreSQL also adds an outbox publication-order index.
  The source-root migration backfills existing materializations, and SQLite rebuilds the OAuth
  authorization-attempt table. Stop old runtime roles and rehearse on a backup before migrating.
  There is no database downgrade path; rollback requires the backup and matching old binaries.
  For SQLite, migrate once before starting multiple runtime roles with `--no-migrate`.
- Custom OAuth adapters must handle optional `codeChallenge`, `codeChallengeMethod`, and
  `codeVerifier` fields. S256 remains the default; explicitly disable PKCE only for providers
  that do not support it. Managed OAuth webhook handlers resolve clients through
  `connections.forAccount(accountId)`.
- Broker subscribers must return their processing promise to apply backpressure. Handler errors
  do not request redelivery; reliable consumers must retry before returning. Retention overrides
  apply when streams are created; existing streams keep their configuration.
- QuickBooks is a first publication at `0.1.0`. The `next` release plan defers its bootstrap;
  rehearse against a local registry before publishing it explicitly under `latest`.

### Package versions

- `0.1.10`: `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/cli`, `@sixb/client`, `@sixb/core`,
  `@sixb/orchestrator`, `@sixb/pg`, `@sixb/pipeline-worker`, `@sixb/projection-worker`,
  `@sixb/rules-worker`, `@sixb/server`, `@sixb/sqlite`, `@sixb/sync-worker`,
  `@sixb/workflow-worker`.
- `0.1.9`: `@sixb/atlas`.
- `0.1.6`: `@sixb/connector-linkedin`, `@sixb/ducklake`.
- `0.1.5`: `@sixb/broker-redis`.
- `0.1.4`: `@sixb/broker-nats`.
- `0.1.3`: `@sixb/connector-tiktok`.
- `0.1.1`: `@sixb/connector-microsoft`.
- `0.1.0`: `@sixb/connector-quickbooks` (first publication).

## 2026-09-18 — Framework 0.1.9

This release includes breaking API changes, a database migration, and a new minimum Bun version.
Review the upgrade notes before updating dependencies or deploying.

### Highlights

- Add direct language-model generation to execution-bound SDKs, including Actions and workflows,
  with shared model-call accounting, recovery, and request/Action/workflow cost attribution.
- Move requester-group snapshots to durable executions so child work inherits the admitted
  snapshot, and expose the expanded attribution in the API, generated client, and Atlas.
- Improve failure details and redact sensitive HTTP context in Atlas and server responses.
- Add web search and web fetch source previews to Agent UI, preserve streamed Gateway reasoning,
  and fix structured output when a model's capability metadata is absent.
- Keep attachment metadata out of assistant history and share production modules between CLI
  configuration loading and discovery.
- Introduce the Microsoft Graph connector for SharePoint/OneDrive files, Outlook mail and delta,
  and calendars, events, and attachments. Subscriptions and webhooks are not part of this release.
- Add Stripe invoice line items and invoice payments, and explicit named Vercel sandbox creation
  and resume.
- Require Bun `1.4.2` or later throughout the published packages. Packages without source changes
  receive a patch release to publish this runtime requirement. Update the starter's dependency
  floors to the versions in this release.

### Upgrade notes

- Upgrade Bun to at least `1.4.2` on development machines, CI, and runtime hosts before installing
  this release. The CLI enforces this minimum.
- Upgrade core, its exact worker and storage consumers, and the CLI to `0.1.9` together. Rebuild
  custom-app and Atlas assets with the selected package versions. Commit the resulting lockfile
  and use frozen installs for deployment.
- Apply PostgreSQL or SQLite migration 037. It moves `requester_group_ids` from Agent and workflow
  runs onto executions, preserves historical snapshots, and drops the former columns. Stop old
  runtime roles before migrating; older binaries must not use the migrated database. Rehearse on
  a backup first. There is no database downgrade path; rolling back requires restoring the backup
  and the matching previous runtime versions. For SQLite, migrate once before starting multiple
  runtime roles with `--no-migrate`.
- Code that reads requester groups from Agent or workflow run records must read the associated
  execution's `requesterGroupIds` instead. Historical snapshots must not be reconstructed from
  current group membership.
- The Vercel factory no longer accepts `persistent`, including `persistent: false`. Remove the
  option for ephemeral sandboxes. Replace persistent creation with
  `factory.create({ persistence: { name } })` and resume stopped state with `factory.resume(name)`.
  Pass current environment and authority on each session. `stop()` preserves persistent state;
  `destroy()` deletes it. Local, Apple Container, and SmolVM providers reject named persistence.
- Implementation helpers are removed from public core exports. Root-level `requestAction`,
  `requestActionAndWait`, `waitForActionRun`, `requestAgentRun`, `requestSyncRun`,
  `requestPipelineRun`, and `requestWorkflowRun` must be replaced with execution-bound SDK calls.
  Root `emptyGrantIndex` and `validateSchemaOrRefValue` are also removed. Client-package request
  helpers and methods on `sixb.objects(...)` are not removed by this export cleanup.
- The `@sixb/core/actions/worker` and `@sixb/core/events/scope` subpaths are removed, along with
  runtime normalization, stream production/control, and storage mutation helpers previously
  exposed through ontology, query, logging, Agent context/streams, and storage entrypoints.
  In particular, `validateSchemaOrRefValue` is no longer exported from `@sixb/core/ontology`.
  Use application-owned validation or supported SDK APIs; `@sixb/core/internal/*` is reserved for
  framework packages and is not an application migration target.

### Package versions

- `0.1.9`: `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/cli`, `@sixb/client`, `@sixb/core`,
  `@sixb/orchestrator`, `@sixb/pg`, `@sixb/pipeline-worker`, `@sixb/projection-worker`,
  `@sixb/rules-worker`, `@sixb/server`, `@sixb/sqlite`, `@sixb/sync-worker`,
  `@sixb/workflow-worker`.
- `0.1.8`: `@sixb/agent-ui`, `@sixb/atlas`.
- `0.1.7`: `@sixb/app`.
- `0.1.5`: `@sixb/cli-core`, `@sixb/connector-google`, `@sixb/connector-linkedin`,
  `@sixb/ducklake`.
- `0.1.4`: `@sixb/auth-magic-link`, `@sixb/broker-redis`, `@sixb/lake-local`,
  `@sixb/queues-bullmq`, `@sixb/sandboxes-apple-container`, `@sixb/sandboxes-local`,
  `@sixb/sandboxes-smolvm`, `@sixb/sandboxes-vercel`.
- `0.1.3`: `@sixb/auth-oidc`, `@sixb/broker-nats`, `@sixb/connector-mercury`,
  `@sixb/connector-meta`, `@sixb/connector-pennylane`, `@sixb/connector-rest`, `create-sixb`.
- `0.1.2`: `@sixb/anthropic`, `@sixb/blob-local`, `@sixb/blob-s3`, `@sixb/connector-companycam`,
  `@sixb/connector-github`, `@sixb/connector-imap`, `@sixb/connector-pandadoc`,
  `@sixb/connector-pipedrive`, `@sixb/connector-sftp`, `@sixb/connector-sql`,
  `@sixb/connector-stripe`, `@sixb/connector-teamleader`, `@sixb/connector-tiktok`,
  `@sixb/connector-unipile`, `@sixb/logger-pino`, `@sixb/ui`, `@sixb/vercel-ai-gateway`.
- `0.1.1`: `@sixb/connector-ace-iot`, `@sixb/connector-exa`, `@sixb/connector-notion`.
- `0.1.0`: `@sixb/connector-microsoft` (first publication).

## 2026-09-14 — Framework 0.1.8

### Highlights

- Add scoped Share grants and isolated shared sessions, with expiration, revocation, CSRF
  protection, and execution provenance. Ordinary custom-app pages and layouts can run under
  shared access without loading application code before authority is established.
- Enforce selected object, link, telemetry, metadata, and Action access throughout delegated
  runtimes, and expose inert, authority-scoped Action descriptors.
- Add `sixb.datasets.ingest` for backend and webhook ingestion, shared source-writing behavior,
  and `sequenceBy` ordering with retained deletion sequences and concurrent-merge retries.
- Initialize empty dataset snapshots, reconcile sequenced snapshots without deleting omitted
  rows, and validate pipeline outputs before committing them.
- Export Agent chat components and hooks for custom layouts, simplify model-message adapters,
  and defer model preparation until needed.
- Reload development apps after backend source changes and preserve Bun runtime options in
  development child processes.
- Clear generated ontology types when the last definition is deleted and correct unit inference
  for unitless telemetry.
- Introduce the token-authenticated Notion Pages and Markdown connector, and add Payment Intents
  and Charges resources to the Stripe connector.

### Upgrade notes

- Apply PostgreSQL or SQLite migrations 035 and 036 for Share grants, shared sessions, and
  delegated execution provenance. Migration 036 replaces execution constraints on PostgreSQL and
  rebuilds the executions table on SQLite. Rehearse on a backup of the previous release; there is
  no database downgrade path. Installations running intermediate main builds must also verify
  migration history and checksums because session migrations were consolidated before release.
- Upgrade core, its exact worker and storage consumers, and the CLI to `0.1.8` together. Rebuild
  custom-app and Atlas assets with the matching release. For SQLite, migrate once before starting
  multiple runtime roles with `--no-migrate`.
- Shared pages require the built-in app server and same-site App/API origins in V1. Static hosting
  adapters are unsupported. Open shared URLs with native links. Shared access excludes WebSockets,
  uploads, direct object/link/telemetry writes, and Action-run listing or files; shared pages are
  not installable as PWAs and require a browser reload after development edits.
- Replace removed legacy `AgentModel*`, `AgentUi*`, and `AgentInboundUi*` message types with the
  appropriate durable Agent types or `@sixb/core/models` types. The legacy `fromUiMessage` and
  `toUiMessage` adapters are removed; `toModelMessages` remains available.
- A sequenced dataset snapshot reconciles rather than replaces: omitted keys remain, and deletion
  requires an explicit sequenced delete. Equal sequences with different content fail the merge.
  Primary keys and `sequenceBy` are immutable; create and backfill a new dataset to change them.
  Timestamp columns in sequenced datasets reject precision beyond milliseconds.
- Dataset commits and notifications remain separate. A crash can leave committed data without a
  notification, and identical sequenced retries do not resend it. Rerun the downstream pipeline
  after a missed notification; durable receipts and automatic notification recovery remain deferred.
- Delegated readers and metadata now enforce the selected authority throughout the SDK. Verify
  custom application reads and Action targets against their intended grants when upgrading.

### Package versions

- `0.1.8`: `@sixb/core`, `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/cli`, `@sixb/client`,
  `@sixb/orchestrator`, `@sixb/pg`, `@sixb/pipeline-worker`, `@sixb/projection-worker`,
  `@sixb/rules-worker`, `@sixb/server`, `@sixb/sqlite`, `@sixb/sync-worker`, and
  `@sixb/workflow-worker`.
- `0.1.7`: `@sixb/agent-ui` and `@sixb/atlas`.
- `0.1.6`: `@sixb/app`.
- `0.1.4`: `@sixb/ducklake`.
- `0.1.3`: `@sixb/lake-local`.
- `0.1.1`: `@sixb/connector-stripe`.
- `0.1.0`: `@sixb/connector-notion` (first publication).

## 2026-09-09 — Framework 0.1.7

### Highlights

- Move language-model inference into the Sixb runtime, add a project model catalog, and introduce
  the first-party `@sixb/anthropic` and `@sixb/vercel-ai-gateway` providers.
- Replace static agent definitions with one project Agent, add first-class conversations and
  workflow Agent steps, and persist the execution state needed for durable child tasks.
- Add aggregate monthly AI usage limits for projects, groups, users, and service accounts, with
  reservation, reconciliation, authorization, server APIs, and Atlas management views.
- Add per-turn model and reasoning controls to Agent UI, with provider branding and preserved user
  preferences.
- Add shared remote-instance commands through `@sixb/cli-core`, CLI profiles, and browser-approved
  device authorization for authenticated instances.
- Keep object file URLs fresh after replacement, refine Atlas workspace navigation and collections,
  and fix LinkedIn UGC analytics list serialization.

### Upgrade notes

- Apply bundled SQLite or PostgreSQL migrations 029–034 before or during deployment. They extend
  model-call accounting, add AI usage-limit state and durable child runs, retire stored static Agent
  identities, and add CLI device authorizations. Validate them on a backup first; this pre-1.0
  release has no database downgrade path.
- Replace `defineAgent` and `createSixb({ agents })` with project `models` and `tools`, move reusable
  instructions from `agents/` into `skills/`, and use `sixb.agent` or `GET /api/agent`. Existing
  conversation history is preserved without its former Agent identity.
- Configure at least one language-model binding for Agent conversations. The new Anthropic and
  Vercel AI Gateway packages read their normal provider credentials lazily; custom integrations
  must provide safe cost-reservation estimates before cost-based usage limits can admit calls.
- Conversational delegation tools remain temporarily disabled. Workflow Agent steps continue to use
  the durable Agent-task execution path.
- Deploy `@sixb/core`, its exact worker and storage consumers, and `@sixb/cli` as one coordinated
  release on `0.1.7`.

### Package versions

- `0.1.7`: `@sixb/core`, `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/cli`, `@sixb/client`,
  `@sixb/orchestrator`, `@sixb/pg`, `@sixb/pipeline-worker`, `@sixb/projection-worker`,
  `@sixb/rules-worker`, `@sixb/server`, `@sixb/sqlite`, `@sixb/sync-worker`, and
  `@sixb/workflow-worker`.
- `0.1.6`: `@sixb/agent-ui` and `@sixb/atlas`.
- `0.1.4`: `@sixb/cli-core` and `@sixb/connector-linkedin`.
- `0.1.3`: `@sixb/queues-bullmq`.
- `0.1.1`: `@sixb/anthropic` and `@sixb/vercel-ai-gateway`.

## 2026-09-07 — Framework 0.1.6

### Highlights

- Add copyable invitation links to Atlas and the auth API, with opt-in support for magic-link and
  OIDC authentication.
- Let custom apps register document viewers through `documentPreviewRenderers`.
- Catch non-JSON Action writeback results at compile time while preserving result inference.
- Fix Action commits that read projected cardinality-many links.
- Fix Atlas navigation for object identifiers containing reserved or Unicode characters.
- Correct the stale core dependency pins published in 0.1.5 and prevent stale lockfile versions from
  reaching future releases.

### Upgrade notes

- No database migration is required.
- Writeback handlers must return JSON-shaped data or no result. Serialize dates and other non-JSON
  values explicitly; existing invalid handlers may now fail typechecking.
- Invitation links are returned only with `revealLink: true`. Treat revealed magic links as sign-in
  credentials.
- Upgrade core, its exact worker and storage consumers, and the CLI to `0.1.6` together.

### Package versions

- `0.1.6`: `@sixb/core`, `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/cli`, `@sixb/client`,
  `@sixb/orchestrator`, `@sixb/pg`, `@sixb/pipeline-worker`, `@sixb/projection-worker`,
  `@sixb/rules-worker`, `@sixb/server`, `@sixb/sqlite`, `@sixb/sync-worker`, and
  `@sixb/workflow-worker`.
- `0.1.5`: `@sixb/agent-ui`, `@sixb/app`, and `@sixb/atlas`.
- `0.1.3`: `@sixb/auth-magic-link`.
- `0.1.2`: `@sixb/auth-oidc`.

## 2026-09-03 — Framework 0.1.5

This selective release is anchored by `@sixb/core` `0.1.5`.

### Highlights

- Add typed, authorized batch telemetry history reads to Actions through
  `read.telemetry.historyBatch(...)`.
- Expose Action input schemas and the CLI command catalog to agents so they can inspect and request
  Actions with less prompt and tool overhead.
- Enable automatic prompt caching for AI Gateway models, with an explicit
  `loop.caching: "off"` opt-out.

### Upgrade notes

- This release contains no SQLite or PostgreSQL schema migration.
- AI Gateway prompt caching is enabled automatically. Set `loop.caching` to `"off"` for workloads
  that must retain the previous behavior. Direct-provider models are unchanged unless their AI SDK
  binding implements caching itself.
- Deploy `@sixb/core`, its exact worker and storage consumers, and `@sixb/cli` as one coordinated
  release so packages importing core internals remain on the same version line.
- This pre-1.0 release has no database downgrade path.

### Package versions

- `0.1.5`: `@sixb/core`, `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/client`,
  `@sixb/orchestrator`, `@sixb/pg`, `@sixb/pipeline-worker`, `@sixb/projection-worker`,
  `@sixb/rules-worker`, `@sixb/server`, `@sixb/sqlite`, `@sixb/sync-worker`,
  `@sixb/workflow-worker`, and `@sixb/cli`.

## 2026-09-01 — Google connector 0.1.4

- `@sixb/connector-google` `0.1.4`: add the complete stable Google Meet REST API v2 surface for
  meeting spaces, conference records, participants and sessions, recordings, transcripts and
  structured entries, and smart notes, including paginated `listAll` iterators.

## 2026-09-01 — Framework 0.1.4

This selective release is anchored by `@sixb/core` `0.1.4`.

### Highlights

- Ship a self-documenting `sixb` CLI inside agent sandboxes, standardize the agent runtime profile,
  and validate each provisioned environment before model-issued commands can execute.
- Compact long agent conversations before they exceed model context limits, deriving budgets from
  the pinned Models.dev catalog while preserving the full durable transcript and exposing
  compaction progress in the agent UI.
- Add an optional project model catalog, validate agent models against it at startup, and expose the
  configured catalog through the server and generated client.
- Add exact-reference object query sources and paginated physical-link queries for object sets,
  with native SQLite and PostgreSQL execution and generated client support.
- Add grouped telemetry projections so one dataset row can atomically emit several readings for an
  object and instant; accept empty sync snapshots and safely handle DuckDB `BIGINT` sums.
- Add feature-owned nested layouts to custom applications and preserve superclass imports in
  production bundles.
- Add TikTok Login Kit Display API support, tighten LinkedIn campaign and creative write contracts,
  and accept equivalent OAuth authorization-code aliases.
- Add resumable npm dist-tag promotion tooling for selectively published framework packages.

### Upgrade notes

- This release contains no SQLite or PostgreSQL schema migration.
- Agent sandboxes are now checked against `sixb-agent-runtime/v1`. Custom images must provide Bash
  bootstrap support, the documented core file utilities, CA certificates, and either Bun 1.3+ or
  Node 22+. Rebuild versioned smolvm images and validate custom sandbox providers before deploying
  the matching agent worker.
- The project model catalog is optional. When configured, every registered agent model must appear
  in the catalog or `createSixb()` fails during startup.
- Deploy `@sixb/core`, its exact worker and storage consumers, and `@sixb/cli` as one coordinated
  release so packages importing core internals remain on the same version line.
- This pre-1.0 release has no database downgrade path.

### Package versions

- `0.1.4`: `@sixb/core`, `@sixb/action-worker`, `@sixb/agent-ui`, `@sixb/agent-worker`,
  `@sixb/app`, `@sixb/atlas`, `@sixb/cli`, `@sixb/client`, `@sixb/orchestrator`, `@sixb/pg`,
  `@sixb/pipeline-worker`, `@sixb/projection-worker`, `@sixb/rules-worker`, `@sixb/server`,
  `@sixb/sqlite`, `@sixb/sync-worker`, and `@sixb/workflow-worker`.
- `0.1.3`: `@sixb/connector-linkedin`, `@sixb/ducklake`,
  `@sixb/sandboxes-apple-container`, `@sixb/sandboxes-local`, `@sixb/sandboxes-smolvm`, and
  `@sixb/sandboxes-vercel`.
- `0.1.1`: `@sixb/connector-tiktok`.

## 2026-08-30 — Framework 0.1.3

This selective release is anchored by `@sixb/core` `0.1.3`.

### Highlights

- Add catalog-backed AI model-call pricing, persist rated and unpriceable valuations, expose cost
  accounting through the server and generated client, and add AI usage analytics to Atlas.
- Preserve long-running agent progress with timeout recovery and durable context checkpoints; let
  agents inspect sandbox files and publish tool-created file and image artifacts.
- Unify conversation and workflow agent execution around one loop, expose detailed execution traces,
  and improve workflow node debugging in Atlas.
- Add configurable per-process worker concurrency while preserving safe defaults and bounded agent
  turn retries.
- Resolve projection sources and edits by recency, retain compact `mostRecent` assertion metadata,
  and persist per-property object override edit times.
- Add custom magic-link authentication experiences for applications and align LinkedIn analytics
  requests with the current API payload contract.

### Upgrade notes

- Apply the bundled SQLite or PostgreSQL migrations before rolling out all runtime roles. Migration
  026 adds AI model-call valuations, 027 adds durable agent context checkpoints, and 028 adds
  per-property edit timestamps to ontology object overrides. Validate the migrations on a backup
  before production rollout.
- Deploy `@sixb/core`, its exact worker and storage consumers, and `@sixb/cli` as one coordinated
  release so packages importing core internals remain on the same version line.
- This pre-1.0 release has no database downgrade path.

### Package versions

- `0.1.3`: `@sixb/core`, `@sixb/action-worker`, `@sixb/agent-ui`, `@sixb/agent-worker`,
  `@sixb/app`, `@sixb/atlas`, `@sixb/cli`, `@sixb/client`, `@sixb/orchestrator`, `@sixb/pg`,
  `@sixb/pipeline-worker`, `@sixb/projection-worker`, `@sixb/rules-worker`, `@sixb/server`,
  `@sixb/sqlite`, `@sixb/sync-worker`, and `@sixb/workflow-worker`.
- `0.1.2`: `@sixb/auth-magic-link` and `@sixb/connector-linkedin`.

## 2026-08-26 — Framework 0.1.2

This selective release is anchored by `@sixb/core` `0.1.2`.

### Highlights

- Add durable execution provenance and AI model-call cost accounting across actions, agents, syncs,
  pipelines, projections, workflows, webhooks, and ontology materialization.
- Persist portable, typed failure records and expose stable error codes through workers, run events,
  the server, and the generated client.
- Add keyed dataset merges, faster ontology materialization, and safer queue, scheduler, Redis, and
  action-wait recovery paths.
- Add managed connector connections with headless APIs and sync fan-out; introduce ACE IoT, Stripe,
  LinkedIn, and TikTok connectors, and expand Google, Meta, REST, and Unipile support.
- Refresh Atlas with an ontology graph explorer and improve the agent thread workspace.

### Upgrade notes

- Apply the bundled SQLite or PostgreSQL migrations before rolling out all runtime roles. Migrations
  022–024 deliberately stop when legacy projection runs, webhook runs or deliveries, or ontology
  commits cannot be assigned honest execution provenance; validate the migration on a backup first.
- This pre-1.0 release has no database downgrade path.

### Package versions

- `0.1.2`: `@sixb/core`, `@sixb/action-worker`, `@sixb/agent-ui`, `@sixb/agent-worker`,
  `@sixb/app`, `@sixb/atlas`, `@sixb/broker-nats`, `@sixb/cli`, `@sixb/client`,
  `@sixb/connector-mercury`, `@sixb/connector-meta`, `@sixb/connector-pennylane`,
  `@sixb/connector-rest`, `@sixb/ducklake`, `@sixb/lake-local`, `@sixb/orchestrator`,
  `@sixb/pg`, `@sixb/pipeline-worker`, `@sixb/projection-worker`, `@sixb/queues-bullmq`,
  `@sixb/rules-worker`, `@sixb/sandboxes-apple-container`, `@sixb/sandboxes-local`,
  `@sixb/sandboxes-smolvm`, `@sixb/sandboxes-vercel`, `@sixb/server`, `@sixb/sqlite`,
  `@sixb/sync-worker`, `@sixb/workflow-worker`, and `create-sixb`.
- `0.1.3`: `@sixb/broker-redis` and `@sixb/connector-google`.
- `0.1.1`: `@sixb/ui`, `@sixb/connector-unipile`, and the new
  `@sixb/connector-linkedin`.
- `0.1.0`: the new `@sixb/connector-ace-iot`, `@sixb/connector-stripe`, and
  `@sixb/connector-tiktok`.

## 2026-08-14

### Redis subscription recovery

- `@sixb/broker-redis` `0.1.2`: recover live subscriptions after a blocked `XREAD`
  connection fails or stalls by replacing disposable subscription clients and resuming from the
  last observed cursor.
- Abort pending subscription client connections and reconnect attempts during unsubscribe or broker
  shutdown so drains complete promptly.


## 2026-08-07

### Workspace dependency compatibility

Adopt hybrid workspace dependency contracts so public packages can release selectively without
letting packages that share core internals drift apart:

- Exact core consumers at `0.1.1`: `@sixb/action-worker`, `@sixb/agent-worker`, `@sixb/cli`,
  `@sixb/orchestrator`, `@sixb/pg`, `@sixb/pipeline-worker`, `@sixb/projection-worker`,
  `@sixb/rules-worker`, `@sixb/server`, `@sixb/sqlite`, `@sixb/sync-worker`, and
  `@sixb/workflow-worker`.
- Compatible public packages at `0.1.1`: `@sixb/agent-ui`, `@sixb/app`, `@sixb/atlas`, and
  `@sixb/client`.
- Compatible plugins and providers at `0.1.1`: `@sixb/auth-magic-link`, `@sixb/auth-oidc`,
  `@sixb/blob-local`, `@sixb/blob-s3`, `@sixb/broker-nats`, `@sixb/broker-redis`,
  `@sixb/connector-companycam`, `@sixb/connector-github`, `@sixb/connector-imap`,
  `@sixb/connector-mercury`, `@sixb/connector-meta`, `@sixb/connector-pandadoc`,
  `@sixb/connector-pennylane`, `@sixb/connector-pipedrive`, `@sixb/connector-rest`,
  `@sixb/connector-sftp`, `@sixb/connector-sql`, `@sixb/connector-teamleader`, `@sixb/ducklake`,
  `@sixb/lake-local`, `@sixb/logger-pino`, `@sixb/queues-bullmq`,
  `@sixb/sandboxes-apple-container`, `@sixb/sandboxes-local`, `@sixb/sandboxes-smolvm`, and
  `@sixb/sandboxes-vercel`.
- `@sixb/connector-exa` adopts the compatible provider contract at `0.1.0`, while
  `@sixb/connector-google` advances to `0.1.2`.
- `create-sixb` advances to `0.1.1` and keeps an explicit compatible range for each framework
  package instead of deriving every range from its own version.

### Package updates

- `@sixb/core` and `@sixb/agent-worker` `0.1.1`: define reusable agent tools and run the tools
  selected by each agent.
- `@sixb/connector-github` `0.1.1`: add users, memberships, members, invitations, and outside
  collaborators.
- `@sixb/sync-worker`, `@sixb/pg`, and `@sixb/sqlite` `0.1.1`: handle empty initial snapshots
  without creating an unusable dataset version.
- `@sixb/connector-exa` `0.1.0`: add bounded web search and fetch tools as a new connector package.
- `@sixb/connector-google` `0.1.2`: add the complete typed Gmail v1 surface.

## 0.1.0

First minimally stable and tested release. Publish this immutable version under npm's `next` tag,
verify the developer flow, then promote the same artifacts to `latest`.

This release refreshes the `create-sixb` starter around a complete satellite-tracking project,
aligns the published documentation with that starter, and makes `0.1.0` the default install line.

### Compatibility

This is a 0.x release and carries no compatibility guarantee. Expect public APIs and persisted
state to change between minor versions. Database schema changes can require recreating the database
before 1.0, and there is no downgrade path.
