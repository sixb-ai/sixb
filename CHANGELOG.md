# Changelog

Sixb packages are versioned independently. Each release entry names the packages that shipped.

## 2026-08-05

### 0.1.1

- `@sixb/core` and `@sixb/agent-worker`: define reusable agent tools and run the tools selected by
  each agent.
- `@sixb/connector-github`: add users, memberships, members, invitations, and outside collaborators.
- `@sixb/sync-worker`, `@sixb/pg`, and `@sixb/sqlite`: handle empty initial snapshots without
  creating an unusable dataset version.

### `@sixb/connector-exa` 0.1.0

Add bounded web search and fetch tools as a new connector package.

### `@sixb/connector-google` 0.1.1

Add the complete typed Gmail v1 surface.

## 0.1.0

First minimally stable and tested release. Publish this immutable version under npm's `next` tag,
verify the developer flow, then promote the same artifacts to `latest`.

This release refreshes the `create-sixb` starter around a complete satellite-tracking project,
aligns the published documentation with that starter, and makes `0.1.0` the default install line.

### Compatibility

This is a 0.x release and carries no compatibility guarantee. Expect public APIs and persisted
state to change between minor versions. Database schema changes can require recreating the database
before 1.0, and there is no downgrade path.
