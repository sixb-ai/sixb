# Examples

The `examples/` folder holds runnable Sixb projects. Clone one, run it with Bun, and read it end to
end. Each is a standard Sixb project: `sixb.config.ts` calls
[`createSixb()`](../runtime/overview.md), while convention folders such as `ontology/`, `actions/`,
and `connectors/` are discovered at startup.

| Example | What it shows | Storage / broker |
| --- | --- | --- |
| `northline` | Canonical commercial service-operations app: three typed source clients, SQL pipelines, projections, actions, workflows, and an optional context-aware operations assistant | SQLite + DuckLake + local sandbox + in-memory broker |
| `auth` | Authentication strategies, groups, membership policies, and scoped roles | SQLite + in-memory broker |
| `panasonic-ac` | Real-device integration: scheduled snapshots, device and telemetry projections, and control actions | Postgres + NATS |
| `roku-tv` | Device discovery, telemetry twins, and remote-control actions | SQLite + in-memory broker |

Run the reference example from the repository root:

```bash
bun --filter @sixb/example-northline dev
```

Or from its folder:

```bash
cd examples/northline
bun run dev
```

## northline — the operations reference

[Northline Mechanical](https://github.com/sixb-ai/sixb/blob/main/examples/northline/README.md) is a fictional commercial HVAC and
building-services operator. Northline Operations connects customer and contract records,
field-service work, and building-controls data around a central `ServiceCase`.

The golden journey is:

```text
alarm -> coverage -> dispatch -> diagnosis -> quote -> repair -> recovery -> closure
```

| Folder | Demonstrates |
| --- | --- |
| `ontology/` | Eleven focused object types including `Equipment`, `ServiceCase`, `WorkOrder`, `ServiceVisit`, and `Quote` — see [Ontology](../ontology/overview.md) |
| `lib/sources/`, `connectors/` | Validated, atomic file-backed source clients behind three typed connectors — see [Connectors](../data/connectors.md) |
| `datasets/`, `syncs/`, `schedules/` | Source-shaped business, field-service, and controls ingestion — see [Datasets](../data/datasets.md) and [Syncs](../data/syncs.md) |
| `pipelines/` | DuckDB SQL for reading normalization, equipment-health derivation, and alarm context assembly — see [Pipelines](../data/pipelines.md) |
| `projections/` | Object, link, and physical telemetry materialization — see [Projections](../data/projections.md) |
| `actions/` | Contract-aware lifecycle commands with idempotent source writeback — see [Actions](../actions/overview.md) |
| `rules/` | Dispatch, SLA, assignment, and recovery attention state — see [Rules](../rules/overview.md) |
| `workflows/` | Deterministic dispatch and repair-quote reviews with human interventions — see [Workflows](../workflows/overview.md) |
| `agents/` | An optional Vercel AI Gateway operations assistant backed by a local development sandbox or hosted smolvm — see [Agents](../agents/overview.md) |
| `app/` | Northline Operations: a compact desktop shell, mobile technician route, and contextual agent panel — see [Apps](../apps/overview.md) |
| `tests/` | Fixed-clock scenario, source persistence, and business identity checks — see [Testing](../testing/overview.md) |

Its `sixb.config.ts` uses local-first providers and needs no external services:

```ts
import { mkdirSync } from "node:fs"
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"
import { SqliteStorage } from "@sixb/sqlite"

const localLakePath = ".sixb/lake"
mkdirSync(localLakePath, { recursive: true })

export const sixb = createSixb({
  id: "northline",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new DuckLakeStorage({
    catalog: { type: "duckdb", path: `${localLakePath}/catalog.ducklake` },
    dataPath: `${localLakePath}/data`,
  }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
  sandboxes:
    process.env.SIXB_SANDBOX_PROVIDER === "smolvm"
      ? new SmolvmSandboxFactory({ image: process.env.SIXB_AGENT_IMAGE, timeout: 30_000 })
      : new LocalSandboxFactory({ timeout: 30_000 }),
})
```

First-run data follows the same path as later refreshes. `bun run dev` initializes source files,
starts the runtime, requests ordered syncs after readiness, and waits for the required projections.
The core example needs no credentials; set `AI_GATEWAY_API_KEY` only to use the embedded Operations
Assistant. Use the explicit replay commands when exploring integration behavior:

```bash
bun run demo:reset
bun run demo:sync
bun run demo:alarm
bun run demo:approve-quote
```

Read the [example README](https://github.com/sixb-ai/sixb/blob/main/examples/northline/README.md) for the complete walkthrough and
recommended code-reading order.

## auth — authentication and access control

A small app focused entirely on [Authentication](../auth/authentication.md) and
[Authorization](../auth/authorization.md). Auth state persists to local SQLite, so you stay
signed in across restarts. Pick the strategy with the `SIXB_AUTH_MODE` environment variable.

| Mode | Package | Setup |
| --- | --- | --- |
| `magic-link` (default) | `@sixb/auth-magic-link` | Zero setup; the sign-in link prints to the terminal |
| `oidc` | `@sixb/auth-oidc` | Set `SIXB_GOOGLE_CLIENT_ID` and `SIXB_GOOGLE_CLIENT_SECRET` |

The strategy is selected when you build the runtime:

```ts
const runtime = await createSixb({
  id: "auth-example",
  // ...storage, broker, queues
  auth:
    authMode === "oidc"
      ? oidc({
          id: "google-workspace",
          issuer: "https://accounts.google.com",
          clientId: requiredEnv("SIXB_GOOGLE_CLIENT_ID"),
          clientSecret: requiredEnv("SIXB_GOOGLE_CLIENT_SECRET"),
          allowedDomains,
          bootstrapUsers,
          bootstrapGroups: [securityAdmins],
          sendInvitation: sendAuthInvitation,
        })
      : magicLink({
          allowedDomains,
          bootstrapUsers,
          bootstrapGroups: [securityAdmins],
          sendMagicLink: sendMagicLinkEmail,
        }),
})
```

Beyond sign-in, the `security/` folder shows the full access-control model:

| File | Demonstrates |
| --- | --- |
| `security/groups/` | The `security-admins` and `team-members` groups |
| `security/policies/` | Security admins can invite, assign groups, suspend, and reactivate users |
| `security/roles/` | Scoped grants for application, objects, datasets, actions, and workflows |

Because grants are scoped, the same UI shows different objects, datasets, and actions depending on
who is signed in. See [Authorization](../auth/authorization.md) for how grants and roles are defined.

## Next

- [Get Started](../README.md) — install Sixb and create a new project
- [Project Structure](../fundamentals/project-structure.md) — convention folders used by examples
- [Ontology](../ontology/overview.md) — model a connected operations domain
