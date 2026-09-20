# Testing contributors

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## Test kinds

Tests live under `<package>/tests/` and split into two tiers by filename.

| Pattern | Tier | Runner | Use for |
| --- | --- | --- | --- |
| `*.test.ts` | Fast | `bun run test` | Pure logic, in-memory runtimes, wiring checks |
| `*.e2e.ts` | End-to-end | `bun run test:e2e` | Real backends, live HTTP servers, slow setup |

```bash
bun run test        # fast *.test.ts only
bun run test:e2e    # *.e2e.ts (package-scoped matrix)
bun run test:all    # both
```

Run targeted files first while iterating, then widen when you touch shared
behavior:

```bash
bun test examples/northline/tests/scenario.test.ts
bun test examples/northline/tests/
```

## Provider contract suites

If you author a backend provider (storage, broker, queue, lake, blob storage,
sandbox, or agent/auth storage), `@sixb/core/testing` exports conformance suites —
`runObjectQueryProviderContractSuite`, `runBrokerContractSuite`,
`runQueueContractSuite`, `runLakeStorageContractSuite`,
`runLakeMergeStorageContractSuite`,
`runBlobStorageContractSuite`, `runAgentStorageContractSuite`,
`runAiUsageStorageContractSuite`, `runAuthStorageContractSuite`, and
`runSandboxesContractSuite` — that assert your implementation satisfies the provider
contract. This is only relevant when building an integration, not when testing an app.

## Query builder parity

For a lighter check that skips HTTP, compare query IR directly — the client and
runtime builders must produce identical IR for the same query:

```ts
expect(objects(Project).query().where((p) => p.p.status.eq("active")).ir).toEqual(
  sixb.objects(Project).query().where((p) => p.p.status.eq("active")).ir
)
```
