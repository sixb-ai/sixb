# Testing

sixb projects are tested with `bun:test` against real runtimes wired up from
in-memory providers. There is no special test harness to learn: you construct a
`Sixb` runtime (or a full `SixbServer`), drive it through the same typed APIs
your app uses, and assert on the results.

This page frames the testing model. Provider authors who need to certify a new
storage, broker, or queue backend should read the
[provider contract suites](#provider-contract-suites) section.

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

Run targeted files first while iterating, then widen to the full suite when you
touch shared behavior:

```bash
bun test examples/acme-corp/tests/client-query.test.ts
bun test packages/core/tests/
```

## In-memory providers as fixtures

`@sixb/core` ships in-memory implementations of every runtime provider. They are
the default fixtures for fast tests: no external services, no disk, fully
deterministic.

| Provider | Constructor |
| --- | --- |
| Object/edit storage | `InMemoryStorage` |
| Broker | `InMemoryBroker` |
| Lake storage | `InMemoryLakeStorage` |
| Blob storage | `InMemoryBlobStorage` |
| Queues | `InMemoryQueues` |

Build a runtime the same way your app does. `createSixb` discovers your project
folders; pass `projectRoot` so it resolves `ontology/`, `datasets/`, and the
rest relative to the example, and override providers with the in-memory ones:

```ts
import { resolve } from "node:path"
import {
  createSixb,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
} from "@sixb/core"

function createTestRuntime() {
  return createSixb({
    id: "auth-example-test",
    projectRoot: resolve(import.meta.dir, ".."),
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}
```

If you prefer to register ontology and definitions explicitly (no folder
discovery), construct `Sixb` directly and pass them in:

```ts
import { Sixb } from "@sixb/core"

const sixb = new Sixb({
  id: "acme-project-progress-test",
  ontology: [Project, Customer, Employee, Department],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
  datasets: [erpProjectProgressDataset],
  projections: [projectProgressProjection],
})
```

### Temp dirs and fixed timestamps

When a test needs a real on-disk provider (for example `SqliteStorage` from
`@sixb/sqlite`), create an isolated temp directory and clean it up so runs never
share state:

```ts
import { afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let root: string

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// inside a test:
root = await mkdtemp(join(tmpdir(), "sixb-test-"))
```

Use fixed timestamps rather than `Date.now()` so assertions are stable. Pass
explicit dates through your APIs and compare against the same literals:

```ts
await sixb.objects(Project).upsert({
  properties: { id: "proj-001", deadline: "2026-09-30" },
})

const dueSoon = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.deadline.lte(new Date("2026-06-30")))
  .list()
```

## Authorization testing

Authorization is enforced at the runtime boundary, so test it by running calls
through an authorization context. Build one with `resolveAuthorizationContext`
(from `@sixb/core`) and scope a runtime to it with `sixb.as(...)`. Every call on
the returned handle is filtered by the principal's grants.

```ts
import { resolveAuthorizationContext } from "@sixb/core"

function atlasContext(sixb, groupIds, userId = "atlas-user") {
  return resolveAuthorizationContext({
    principal: { type: "user", id: userId },
    groupIds,
    roles: sixb.security.getResolvedRoles(),
  })
}

const teamMember = sixb.as(atlasContext(sixb, ["team-members"]))
const admin = sixb.as(atlasContext(sixb, ["security-admins"]))
const noGroups = sixb.as(atlasContext(sixb, []))
```

Assert both what a principal *can* see and what it *cannot*. Denied operations
reject with package-prefixed errors:

```ts
// team members only see the object types their roles grant
expect((await teamMember.list({})).objects.map((o) => o.objectTypeId)).toEqual(["note"])

await expect(teamMember.getObject("admin-note", "admin-note")).rejects.toThrow(
  "not allowed to view object type 'admin-note'"
)

// listings are filtered too
expect(teamMember.listActions().map((a) => a.id)).toEqual(["acknowledge-note"])
expect(teamMember.listDatasets().map((d) => d.id)).toEqual([teamNotesDataset.id])

// an ungranted principal sees nothing
expect(await noGroups.list({})).toEqual({ objects: [], hasMore: false, total: 0 })
```

See [authorization](../auth/authorization.md) for how roles, grants, and groups
resolve. The full pattern lives in `examples/auth/tests/atlas-authorization.test.ts`.

## Client/server e2e

End-to-end tests start a real `SixbServer` over HTTP and drive it with the typed
`@sixb/client` builders, proving the client and server agree on the wire format.
Mirror `examples/acme-corp/tests/client-query.test.ts`:

1. Build a `Sixb` runtime and seed data through `sixb.objects(...)`.
2. Allocate a free port, start a `SixbServer` bound to it.
3. Point the client at the server with `client.setConfig({ baseUrl })`.
4. Run queries through `objects(...)` from `@sixb/client/query` and assert.
5. Stop the server and close storage in `afterAll`.

```ts
import { afterAll, beforeAll, expect, test } from "bun:test"
import { client } from "@sixb/client"
import { objects } from "@sixb/client/query"
import { SixbServer } from "@sixb/server"

let server: SixbServer

beforeAll(async () => {
  // ...seed sixb...
  server = new SixbServer({
    sixb,
    host: "127.0.0.1",
    port,
    quiet: true,
    browser: {
      publicOrigin: baseUrl,
      allowedOrigins: [{ origin: baseUrl, audience: "atlas", kind: "atlas" }],
    },
  })
  await server.start()
  client.setConfig({ baseUrl })
})

afterAll(async () => {
  await server?.stop()
})

test("list() returns the same objects as the server runtime", async () => {
  const viaHttp = await objects(Project)
    .query()
    .where((project) => project.p.status.eq("active"))
    .list()

  const viaRuntime = await sixb
    .objects(Project)
    .query()
    .where((project) => project.p.status.eq("active"))
    .list()

  expect(viaHttp.objects.map((o) => o.primaryId)).toEqual(
    viaRuntime.objects.map((o) => o.primaryId)
  )
})
```

A lighter check is to compare query IR without HTTP — the client and runtime
builders must produce identical IR for the same query:

```ts
expect(objects(Project).query().where((p) => p.p.status.eq("active")).ir).toEqual(
  sixb.objects(Project).query().where((p) => p.p.status.eq("active")).ir
)
```

See [typed queries](../client/typed-queries.md) and [server](../server/overview.md).

## Provider contract suites

If you author a backend (storage, broker, queue, lake, or sandbox provider),
`@sixb/core/testing` exports conformance suites that assert your implementation
satisfies the provider contract. Register a suite in a test file and it emits its
own `describe`/`test` cases.

| Export | Certifies |
| --- | --- |
| `runObjectQueryProviderContractSuite` | Object query/storage providers |
| `runAuthStorageContractSuite` | Authorization storage |
| `runLakeStorageContractSuite` | Lake storage |
| `runBrokerContractSuite` | Brokers |
| `runQueueContractSuite` | Queues |
| `runSandboxesContractSuite` | Sandbox factories |

Each suite takes a name and options that create and tear down an instance:

```ts
import { runObjectQueryProviderContractSuite } from "@sixb/core/testing"
import { SqliteObjectStorage } from "../src"

runObjectQueryProviderContractSuite("SqliteObjectStorage object query provider contract", {
  createStorage: () => new SqliteObjectStorage(),
  teardown: (storage) => storage.close(),
})
```

The object-query suite also exports `objectQueryContractOntology` and
`seedObjectQueryContractData` if you need the same fixtures outside the suite.

The sandbox surface (`Sandbox`, `SandboxFactory`, `CreateSandboxOptions`,
`RunCommandOptions`, `CommandResult`) and its errors are exported from
`@sixb/core/sandboxes` for sandbox-provider authors; certify a factory with
`runSandboxesContractSuite`.

## See also

- [Examples](../examples/overview.md) — runnable projects whose tests are the canonical patterns
- [Authorization](../auth/authorization.md)
- [Client typed queries](../client/typed-queries.md)
- [Server](../server/overview.md)
