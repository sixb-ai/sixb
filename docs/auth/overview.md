# Auth

Auth in sixb is two independent layers:

- **Authentication** answers **who** a principal is — identity, login strategies, and sessions.
- **Authorization** answers **what** that principal may do — grants on objects, actions, and workflows, defined against groups and roles.

A request first resolves an identity (authentication), then resolves that identity's group memberships into a set of grants (authorization). The two layers never overlap: being signed in says nothing about what you can reach, and a grant means nothing until a principal is attached to it.

## The two layers

| Layer | Answers | Covers | Page |
| --- | --- | --- | --- |
| Authentication | Who you are | Login strategies (magic link, OIDC), sessions, cookies, sign-in endpoints | [Authentication](./authentication.md) |
| Authorization | What you may do | Groups, roles, grants (`can.view` / `can.apply` / `can.run`), invite policies, scoped runtime | [Authorization](./authorization.md) |

## How they connect

You configure authentication through the `auth` option on `createSixb()`, and authorization through `defineGroup`, `defineRole`, and `defineInvitePolicy`.

```ts
import { createSixb, defineGroup, defineRole, can, ontology } from "@sixb/core"
import { magicLink } from "@sixb/auth-magic-link"

export const securityAdmins = defineGroup("security-admins", { label: "Security admins" })

export const securityAdminAccess = defineRole("security-admin.full-access", {
  grantedTo: [securityAdmins],
  grants: [can.view(ontology.objects())],
})

export const sixb = createSixb({
  // ...storage, broker, and the rest of the runtime
  auth: magicLink({
    allowedDomains: ["example.com"],
    bootstrapUsers: ["admin@example.com"],
    bootstrapGroups: [securityAdmins],
    sendMagicLink: async ({ email, url }) => console.log(`${email}: ${url}`),
  }),
})
```

Once a principal is signed in, the server resolves its identity and group memberships into an authorization context and routes traffic through `sixb.as(context)`, so grants are enforced without extra wiring.

## Bootstrap

Bootstrap is where the two layers meet: the auth strategy's `bootstrapUsers` and `bootstrapGroups` seed the first account and place it into its starting groups, which is what gives the first sign-in the grants to administer everything else. Because it is configured on the `auth` strategy, bootstrap is documented canonically on the [Authentication](./authentication.md) page.

## Where to go next

- [Authentication](./authentication.md) — pick a strategy, set allowed domains and bootstrap, manage sessions and invitations.
- [Authorization](./authorization.md) — define groups, roles, and grants, and enforce them with the scoped runtime.

For how the server resolves sessions and applies the authorization context per request, see [Server](../server/overview.md).
