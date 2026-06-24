# Examples

The `examples/` folder holds runnable Sixb projects. Each is a complete app you can
clone, run with `bun dev`, and read end to end. Use them as working references for how the
concepts fit together in a real project.

## Mental model

Every example is a standard Sixb project: a `sixb.config.ts` that calls
[`createSixb()`](../runtime/overview.md), plus convention folders (`ontology/`, `actions/`,
`connectors/`, and so on) that are auto-discovered at startup. The examples differ in
*which* capabilities they exercise, not in how they are wired.

| Example | Shows off | Storage / broker |
| --- | --- | --- |
| `acme-corp` | Full operations app: ontology, syncs, pipelines, projections, rules, workflows, actions, custom app, typed client | SQLite + in-memory broker |
| `auth` | Authentication strategies, groups, roles, invite policies, scoped access | SQLite + in-memory broker |

Run any example from its own folder:

```bash
cd examples/acme-corp
bun dev
```

## acme-corp — full operations app

A back-office app for an invoicing and project-management company. It is the broadest
example and touches nearly every concept.

| Folder | Demonstrates |
| --- | --- |
| `ontology/` | Object types for `Customer`, `Department`, `Document`, `Employee`, `Invoice`, `Project`, `Task`, with links between them — see [Ontology](../ontology/overview.md) |
| `connectors/`, `lib/` | A connector to a mock ERP system — see [Connectors](../data/connectors.md) |
| `datasets/`, `syncs/`, `schedules/` | Pulling ERP rows into datasets on a schedule — see [Datasets](../data/datasets.md) and [Syncs](../data/syncs.md) |
| `pipelines/` | `project-reporting` transforms dataset rows — see [Pipelines](../data/pipelines.md) |
| `projections/` | Mapping datasets and pipeline output into ontology objects — see [Projections](../data/projections.md) |
| `actions/` | `createDraftInvoice`, `markPaid`, `sendReminder`, `deleteInvoice` — see [Actions](../actions/overview.md) |
| `functions/` | `check-overdue-invoices` runs on a schedule |
| `rules/` | `business-health` evaluates object state — see [Rules](../rules/overview.md) |
| `workflows/` | `invoice-reminder` drives a multi-step process — see [Workflows](../workflows/overview.md) |
| `app/` | A custom React app with project, review, and intervention pages — see [Apps](../apps/overview.md) |

Its `sixb.config.ts` uses local-first providers so it runs with no external services:

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

It also ships demo scripts: `bun run sync:erp` and `bun run webhooks:demo`.

## auth — authentication and access control

A tiny app focused entirely on [Authentication](../auth/authentication.md) and
[Authorization](../auth/authorization.md). It supports two strategies, switched with the
`SIXB_AUTH_MODE` environment variable.

| Mode | Package | Setup |
| --- | --- | --- |
| `magic-link` (default) | `@sixb/auth-magic-link` | Zero setup; the sign-in link prints to the terminal |
| `oidc` | `@sixb/auth-oidc` | Set `SIXB_GOOGLE_CLIENT_ID` and `SIXB_GOOGLE_CLIENT_SECRET` |

The strategy is selected when building the runtime:

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
| `security/groups/` | `security-admins` and `team-members` groups |
| `security/invite-policies/` | Security admins can invite people into `team-members` |
| `security/roles/` | Scoped grants per group — `team-members` get view on `Note`, view on one dataset, and apply on `acknowledge-note`; `security-admins` use wildcard grants |

Because grants are scoped, the same UI shows different objects, datasets, and actions
depending on who is signed in. See [Authorization](../auth/authorization.md) for how grants
and roles are defined.

## Related pages

- [Get Started](../README.md) — install Sixb and create a new project
- [Project Structure](../fundamentals/project-structure.md) — the convention folders these examples use
