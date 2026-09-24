# Shared access

Shared access gives someone a link to a specific object without adding them to your team. A Share definition controls what the link lets them read and which actions they may run.

## Define shared access

Export a Share definition from `shares/`. This example shares one invoice and allows the recipient to run the project's `approveInvoice` action on it.

```ts
// shares/invoice.ts
import { can, defineShare } from "@sixb/core"
import { approveInvoice } from "../actions/approve-invoice"
import { Invoice } from "../ontology/invoice"

export const invoiceShare = defineShare("invoice", {
  target: Invoice,
  grants: ({ target }) => [
    can.view(target),
    can.apply(approveInvoice).on(target),
  ],
})
```

`target` represents the exact invoice selected when the link is issued. Other invoices remain inaccessible.

To include related objects, select their links explicitly:

```ts
can.view(target).withLinks([Invoice.l.customer])
```

Nested relationships stay private unless selected too. These grants do not give the recipient direct write or upload access.

## Allow sharing

Add `can.share(invoiceShare)` to the issuer's [role](authorization.md). It permits issuing, listing, and revoking links for this definition; it does not grant access to invoice data by itself.

```ts
import { can, defineRole } from "@sixb/core"
import { Invoice } from "../../ontology/invoice"
import { invoiceShare } from "../../shares/invoice"
import { financeTeam } from "../groups/finance-team"

export const invoiceSharing = defineRole("invoice-sharing", {
  grantedTo: [financeTeam],
  grants: [can.view(Invoice), can.share(invoiceShare)],
})
```

## Issue a link

From an authenticated app, use the [Client SDK](../client/overview.md) to issue a link with an expiration and a destination in your custom app:

```ts
import { issueSharedAccessGrant } from "@sixb/client"

const { data } = await issueSharedAccessGrant({
  body: {
    definitionId: "invoice",
    target: { objectTypeId: "Invoice", primaryId: "inv-1" },
    destinationPath: "/invoices/inv-1",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  },
  throwOnError: true,
})

const url = data.url
```

The URL is returned only when issued. Anyone holding it can use its permitted access until it expires or is revoked. The destination is a normal [app page](../apps/overview.md); its queries and action buttons use the shared session automatically.

## Revoke access

Use `revokeSharedAccessGrant` with the issued grant ID. Narrowing the Share definition also narrows existing links; widening it does not add permissions to links already issued.

Revoke outstanding grants before permanently removing or reusing a Share definition's ID. Shared sessions currently do not support WebSockets, uploads, direct object writes, or action parameters containing object, file, or user references.
