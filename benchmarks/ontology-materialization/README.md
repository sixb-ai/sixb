# Ontology materialization benchmark

Private manual benchmark for validating ontology replacement materialization at realistic volume.
It measures staging, semantic finalization, storage growth, peak RSS, and competing-writer delay.

The benchmark verifies persisted object counts but deliberately defines no machine-dependent timing
threshold. It is not part of the standard test suite.

## SQLite

```bash
bun run benchmark:ontology-materialization --provider sqlite --rows 1000000
```

## PostgreSQL

Set `DATABASE_URL` to an isolated test database, then run:

```bash
bun run benchmark:ontology-materialization --provider postgres --rows 1000000
```

Each run uses isolated storage and removes it on completion.
