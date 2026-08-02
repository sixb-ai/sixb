# Changelog

All Sixb packages ship on one version. A release publishes all of them or none.

## 0.0.1

First public preview release. This version is published under npm's `next` tag and is not the
recommended `latest` release.

Sixb gives operational systems a shared backbone: a typed ontology, and the primitives that read and
write it — actions, workflows, rules, events, schedules, agents, datasets, syncs, pipelines,
projections, connectors, and webhooks. Storage, broker, queues, lake, blob, and sandbox are provider
contracts with implementations for PostgreSQL, SQLite, Redis, NATS, BullMQ, S3, DuckLake, and the
local filesystem.

Start with:

```bash
bun create sixb my-app
```

### Compatibility

This is a 0.0.x preview and carries no compatibility guarantee. Expect public APIs and persisted
state to change between any two preview versions.

The database schema is one migration whose checksum is verified at startup. Before 1.0, a schema
change **replaces** that migration rather than adding another, so moving between 0.x versions can
require recreating the database. There is no downgrade path.

Bun 1.3 or newer is required. These packages import Bun APIs directly and do not run on Node.
