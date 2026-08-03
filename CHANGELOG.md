# Changelog

All Sixb packages ship on one version. A release publishes all of them or none.

## Unreleased

### Breaking

**A database created by 0.1.0 must be recreated.** Every run table now records one failure record
in a single `error` column, replacing the `error_name`/`error_message` pair. Before 1.0 a schema
change replaces the initial migration instead of adding another, so the startup checksum no longer
matches what 0.1.0 wrote and the runtime refuses to start:

```
[SixbPostgresStorage] Applied migration checksum changed: 001-initial-schema
```

Drop and recreate the schema — `dropSchema()` on the Postgres provider, or delete the SQLite file.
There is no downgrade path and no data migration.

**Websocket stream errors are objects.** `onError` on the event, log and agent-run sockets — and
the `error` field of their state — hand over a `SixbFailure` (`{ code, message }`) instead of a
string. Read `.message` where you rendered the string, and branch on `.code`.

## 0.1.0

First minimally stable and tested release. Publish this immutable version under npm's `next` tag,
verify the developer flow, then promote the same artifacts to `latest`.

This release refreshes the `create-sixb` starter around a complete satellite-tracking project,
aligns the published documentation with that starter, and makes `0.1.0` the default install line.

### Compatibility

This is a 0.x release and carries no compatibility guarantee. Expect public APIs and persisted
state to change between minor versions. Database schema changes can require recreating the database
before 1.0, and there is no downgrade path.
