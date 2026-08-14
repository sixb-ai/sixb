# Changelog

Sixb packages are versioned independently. Each release entry names the packages that shipped.

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
