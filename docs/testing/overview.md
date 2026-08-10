# Testing

You test a Sixb project with `bun:test` against a real runtime wired from
in-memory providers. There is no special harness: construct a `Sixb` runtime (or
a full `SixbServer`), drive it through the same typed APIs your app uses, and
assert on the results.

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

Build the runtime the same way your app does. `createSixb` discovers your
project folders, so pass `projectRoot` to resolve `ontology/`, `datasets/`, and
the rest relative to the project, then override providers with the in-memory
ones:

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
    id: "acme-test",
    projectRoot: resolve(import.meta.dir, ".."),
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}
```

`createSixb` is async, so `await` it. To skip folder discovery and register
ontology and definitions explicitly, construct `Sixb` directly:

```ts
import { Sixb } from "@sixb/core"

const sixb = new Sixb({
  id: "acme-progress-test",
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

Seed objects through the typed API, then assert on queries:

```ts
await sixb.objects(Customer).upsert({
  properties: {
    id: "cust-001",
    name: "Dana Smith",
    email: "dana@globex.test",
    company: "Globex",
    tier: "gold",
  },
})

await sixb.objects(Project).upsert({
  properties: { id: "proj-001", name: "Energy Dashboard", status: "active", budget: 120_000 },
})

const active = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.status.eq("active"))
  .list()

expect(active.objects.map((o) => o.primaryId)).toEqual(["proj-001"])
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

Use fixed timestamps rather than `Date.now()` so date assertions stay stable.
Pass explicit dates through your APIs and compare against the same literals:

```ts
await sixb.objects(Project).upsert({
  properties: { id: "proj-002", name: "Warehouse Retrofit", deadline: "2026-03-31" },
})

const dueSoon = await sixb
  .objects(Project)
  .query()
  .where((project) => project.p.deadline.lte(new Date("2026-06-30")))
  .list()

expect(dueSoon.objects.map((o) => o.primaryId)).toEqual(["proj-002"])
```

## Authorization testing

Authorization is enforced at the runtime boundary, so test it by running calls
through an authorization context. Build one with `resolveAuthorizationContext`
and scope the runtime to a principal with `sixb.as(...)`. Every call on the
returned handle is filtered by that principal's grants.

```ts
import {
  resolveAuthorizationContext,
  type OntologySource,
  type Sixb,
} from "@sixb/core"

function asUser(
  sixb: Sixb<readonly OntologySource[]>,
  groupIds: readonly string[],
  userId = "user-1"
) {
  return resolveAuthorizationContext({
    principal: { type: "user", id: userId },
    groupIds,
    roles: sixb.security.listResolvedRoles(),
  })
}

const teamMember = sixb.as(asUser(sixb, ["team-members"]))
const financeAdmin = sixb.as(asUser(sixb, ["finance-admins"]))
const anonymous = sixb.as(asUser(sixb, []))
```

Assert both what a principal *can* and *cannot* do. Listings are filtered to
granted definitions, and denied operations reject with package-prefixed errors:

```ts
// team members can view Customer but not Invoice
expect((await teamMember.objects.list({})).objects.map((o) => o.objectTypeId)).toEqual(["Customer"])
await expect(teamMember.objects.get("Invoice", "inv-001")).rejects.toThrow(
  "not allowed to view object type 'Invoice'"
)

// action and dataset listings only include granted definitions
expect(teamMember.actions.list().map((a) => a.id)).not.toContain("markPaid")
await expect(
  teamMember.actions.request({
    actionId: "markPaid",
    subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-001" },
  })
).rejects.toThrow("not allowed to apply action 'markPaid'")

// finance admins can apply invoice actions
await expect(
  financeAdmin.actions.request({
    actionId: "markPaid",
    subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv-001" },
  })
).resolves.toMatchObject({ runId: expect.any(String) })

// an ungranted principal sees nothing
expect(await anonymous.objects.list({})).toEqual({ objects: [], hasMore: false, total: 0 })
```

There are eleven grant kinds. `access:application` gates browser applications at the server
boundary, and `observe:logs` gates reading captured [logs](../logging/overview.md). The scoped
runtime gates the rest: `view:object` (`objects.list`/`objects.get`), `view:dataset`
(`datasets.list`), `edit:object` (`objects.upsert`, links, `delete`), `append:telemetry`
(`objects.appendTelemetry`), `apply:action` (`actions.request`), `run:workflow`
(`workflows.requestById`), `run:sync` (`syncs.request`), `run:pipeline` (`pipelines.request`), and
`run:agent` (`agents.request`). See [authorization](../auth/authorization.md) for how roles,
grants, groups, and membership policies resolve; the full pattern lives in
`examples/auth/tests/atlas-authorization.test.ts`.

A write test needs **both** `can.view(Type)` and `can.edit(Type)`; a telemetry-only test needs
`can.append(Type)` and nothing else.

## Client/server e2e

End-to-end tests start a real `SixbServer` over HTTP and drive it with the typed
`@sixb/client` builders, proving the client and server agree on the wire format.
Use this shape for a full typed-client/server contract test:

1. Build a `Sixb` runtime and seed data through `sixb.objects(...)`.
2. Allocate a free port and start a `SixbServer` bound to it.
3. Point the client at the server with `client.setConfig({ baseUrl })`.
4. Run queries through `objects(...)` from `@sixb/client/query` and assert.
5. Stop the server in `afterAll`.

```ts
import { afterAll, beforeAll, expect, test } from "bun:test"
import { client } from "@sixb/client"
import { objects } from "@sixb/client/query"
import { SixbServer } from "@sixb/server"

let server: SixbServer

beforeAll(async () => {
  // ...build and seed sixb, then pick a free port...
  const baseUrl = `http://127.0.0.1:${port}`
  server = new SixbServer({
    sixb,
    host: "127.0.0.1",
    port,
    quiet: true,
    browser: {
      publicOrigin: baseUrl,
      allowedOrigins: [{ origin: baseUrl, audience: "atlas" }],
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

For a lighter check that skips HTTP, compare query IR directly — the client and
runtime builders must produce identical IR for the same query:

```ts
expect(objects(Project).query().where((p) => p.p.status.eq("active")).ir).toEqual(
  sixb.objects(Project).query().where((p) => p.p.status.eq("active")).ir
)
```

## Provider contract suites

If you author a backend provider (storage, broker, queue, lake, blob storage,
sandbox, or agent/auth storage), `@sixb/core/testing` exports conformance suites —
`runObjectQueryProviderContractSuite`, `runBrokerContractSuite`,
`runQueueContractSuite`, `runLakeStorageContractSuite`,
`runLakeMergeStorageContractSuite`,
`runBlobStorageContractSuite`, `runAgentStorageContractSuite`,
`runAuthStorageContractSuite`, and `runSandboxesContractSuite` — that assert your
implementation satisfies the provider contract. This is only relevant when
building an integration, not when testing an app.

## Related

- [Examples](../examples/overview.md) — runnable projects whose tests are the canonical patterns
- [Authorization](../auth/authorization.md)
- [Client typed queries](../client/typed-queries.md)
- [Server](../server/overview.md)
