# Auth

Auth in Sixb is two independent layers. Reach for it whenever more than one person touches your runtime.

- **Authentication** answers **who** a principal is — identity, login strategies, and sessions.
- **Authorization** answers **what** that principal may do — grants on objects, datasets, actions, workflows, syncs, and pipelines, defined against groups and roles.

A request first resolves an identity (authentication), then resolves that identity's group memberships into a set of grants (authorization). The layers never overlap: being signed in says nothing about what you can reach, and a grant means nothing until a principal is attached to it.

## The two layers

| Layer | Answers | Covers | Page |
| --- | --- | --- | --- |
| Authentication | Who you are | Login strategies (magic link, OIDC), sessions, cookies, bootstrap, invitations | [Authentication](./authentication.md) |
| Authorization | What you may do | Groups, roles, grants (`can.view` / `can.apply` / `can.run`), invite policies, the scoped runtime | [Authorization](./authorization.md) |

## How they connect

You configure authentication through the `auth` option on `createSixb()`, and authorization through `defineGroup`, `defineRole`, and `defineInvitePolicy`.

```ts
import { createSixb, can, defineGroup, defineRole } from "@sixb/core"
import { magicLink } from "@sixb/auth-magic-link"
import { Customer } from "./ontology/customer"
import { Invoice } from "./ontology/invoice"
import { markPaid, sendReminder } from "./actions/invoice"

// WHO: a group is a named bucket of principals.
export const financeAdmins = defineGroup("finance-admins", { label: "Finance admins" })

// WHAT: a role attaches grants to one or more groups.
export const financeAccess = defineRole("finance-admin.access", {
  grantedTo: [financeAdmins],
  grants: [can.view(Customer), can.view(Invoice), can.apply([markPaid, sendReminder])],
})

export const sixb = await createSixb({
  // ...storage, broker, and the rest of the runtime
  auth: magicLink({
    allowedDomains: ["acme.example"],
    bootstrapUsers: ["admin@acme.example"],
    bootstrapGroups: [financeAdmins],
    sendMagicLink: async ({ email, url }) => console.log(`${email}: ${url}`),
  }),
})
```

Groups and roles are discovered from `security/` (or passed to `createSixb`) just like the rest of your runtime. Once a principal signs in, the server resolves its identity and group memberships into an authorization context and routes traffic through `sixb.as(context)`, so grants are enforced without extra wiring.

## Bootstrap

Bootstrap is where the two layers meet. The auth strategy's `bootstrapUsers` and `bootstrapGroups` seed the first account and drop it into its starting groups — that is what gives the first sign-in the grants to administer everything else. Because it lives on the `auth` strategy, bootstrap is documented on the [Authentication](./authentication.md) page.

## Next

- [Authentication](./authentication.md) — pick a strategy, set allowed domains and bootstrap, manage sessions and invitations.
- [Authorization](./authorization.md) — define groups, roles, and grants, and enforce them with the scoped runtime.
- [Server](../server/overview.md) — how the server resolves sessions and applies the authorization context per request.
