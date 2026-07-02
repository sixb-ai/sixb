# Examples

The `examples/` folder holds runnable Sixb projects. Clone one, run it with `bun dev`, and read
it end to end. Use them as working references for how the pieces fit together in a real app.

Each example is a standard Sixb project: a `sixb.config.ts` that calls
[`createSixb()`](../runtime/overview.md) plus convention folders (`ontology/`, `actions/`,
`connectors/`, and so on) that are auto-discovered at startup. They differ in *which* capabilities
they exercise, not in how they are wired.

| Example | What it shows | Storage / broker |
| --- | --- | --- |
| `acme-corp` | The canonical business-operations app: ontology, connectors, syncs, pipelines, projections, file attachments, actions, rules, workflows, scheduled functions, a custom React app, and a typed client | SQLite + in-memory broker |
| `auth` | Authentication strategies, groups, membership policies, and scoped roles | SQLite + in-memory broker |

Run any example from its own folder:

```bash
cd examples/acme-corp
bun dev
```

`acme-corp` is the reference these docs are built on. Every code sample across the documentation
models the same domain — a company running its operations on Sixb: the `Customer`s it serves, the
`Project`s it delivers, the `Employee`s who do the work, and the `Invoice`s it bills.

## acme-corp — the business-OS reference

A back-office app for a company that delivers projects and bills for them. It is the broadest
example and touches nearly every concept in Sixb, so it is the one to read first.

| Folder | Demonstrates |
| --- | --- |
| `ontology/` | Object types `Customer`, `Department`, `Document`, `Employee`, `Invoice`, `Project`, `Task`, with links between them — see [Ontology](../ontology/overview.md) |
| `connectors/`, `lib/` | An `acme-erp` connector to a mock ERP exposing customers, invoices, employees, and departments — see [Connectors](../data/connectors.md) |
| `datasets/`, `syncs/`, `schedules/` | Pulling ERP rows into datasets like `erp.invoices` and file-backed `erp.documents` rows on a schedule — see [Datasets](../data/datasets.md) and [Syncs](../data/syncs.md) |
| `pipelines/` | `project-reporting` transforms dataset rows — see [Pipelines](../data/pipelines.md) |
| `projections/` | Mapping dataset and pipeline rows into ontology objects — see [Projections](../data/projections.md) |
| `actions/` | `createDraftInvoice`, `markPaid`, `sendReminder`, `deleteInvoice` — see [Actions](../actions/overview.md) |
| `functions/` | `check-overdue-invoices` runs on a cron schedule — see [Schedules](../schedules/overview.md) |
| `rules/` | Business-health rules like `invoice.collection-risk` and `project.large-active-engagement` — see [Rules](../rules/overview.md) |
| `workflows/` | `invoice-reminder` drives a multi-step process with a human approval step — see [Workflows](../workflows/overview.md) |
| `app/` | A custom React app with project, review, and intervention pages — see [Apps](../apps/overview.md) |

Its `sixb.config.ts` uses local-first providers, so it runs with no external services:

```ts
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { SqliteStorage } from "@sixb/sqlite"

export const sixb = createSixb({
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
})
```

Two demo scripts seed the system from the mock ERP and replay events:

```bash
bun run sync:erp       # pull ERP rows into datasets, then project them into objects
bun run webhooks:demo  # send sample webhook events at the running app
```

The ERP document sync stores a sample PDF and PNG through Sixb blob storage, writes them as
`fileRef` values into `erp.documents`, and projects them onto `Document.attachment`. After
`bun run sync:erp`, open Atlas, go to Objects, and select a Document to view or download the
attachment with the native browser viewer.

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
| `security/policies/` | Security admins can invite, assign groups, suspend, and reactivate users in `team-members` and `security-admins` |
| `security/roles/` | Scoped grants per group — `team-members` get `can.view(Note)`, view on the team-notes dataset, and `can.apply(acknowledgeNote)`; `security-admins` get wildcard grants over all objects, datasets, actions, and workflows |

Because grants are scoped, the same UI shows different objects, datasets, and actions depending on
who is signed in. See [Authorization](../auth/authorization.md) for how grants and roles are defined.

## Next

- [Get Started](../README.md) — install Sixb and create a new project
- [Project Structure](../fundamentals/project-structure.md) — the convention folders these examples use
- [Ontology](../ontology/overview.md) — model the `acme-corp` domain yourself
